//! Optional, user-owned See-through component management and local inference.
//!
//! This module stores only a pointer/manifest and job artifacts in a directory
//! selected by the user. It never ships Python or model weights with IB, and it
//! never deletes an external source tree, Python environment, or model cache.

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::VecDeque;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, Sender};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;

const AI_COMPONENT_SCHEMA: &str = "internalbeyond.puppet-ai-component.v1";
const AI_REGISTRY_SCHEMA: &str = "internalbeyond.puppet-ai-registry.v1";
const AI_RESULT_CHUNK_BYTES: usize = 256 * 1024;
const AI_INPUT_LIMIT_BYTES: usize = 32 * 1024 * 1024;
const AI_RESULT_LIMIT_BYTES: u64 = 768 * 1024 * 1024;
const AI_PROGRESS_EVENT: &str = "ib-puppet-ai-progress";
const LAYERDIFF_MODEL: &str = "24yearsold/seethroughv0.0.2_layerdiff3d_nf4";
const LAYERDIFF_REVISION: &str = "96f9311ff449dc86cfaba101ce4dfb4fd4958b80";
const MARIGOLD_MODEL: &str = "24yearsold/seethroughv0.0.1_marigold_nf4";
const MARIGOLD_REVISION: &str = "e53b344b5aa5beec7c141bd5601decaaff0898c9";
const MODEL_DOWNLOAD_RESERVE_BYTES: u64 = 8 * 1024 * 1024 * 1024;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AiRegistry {
    schema: String,
    component_directory: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AiComponentManifest {
    schema: String,
    version: String,
    component_directory: String,
    source_directory: String,
    python_executable: String,
    #[serde(default)]
    managed_python_directory: Option<String>,
    model_directory: String,
    source_revision: String,
    layerdiff_revision: String,
    marigold_revision: String,
    inference_script_sha256: String,
    python_version: String,
    torch_version: String,
    cuda_version: String,
    gpu_name: String,
    license_acknowledged: bool,
    installed_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiComponentStatus {
    pub installed: bool,
    pub ready: bool,
    pub version: Option<String>,
    pub component_directory: Option<String>,
    pub source_directory: Option<String>,
    pub source_revision: Option<String>,
    pub layerdiff_revision: Option<String>,
    pub marigold_revision: Option<String>,
    pub python_executable: Option<String>,
    pub managed_python_directory: Option<String>,
    pub python_version: Option<String>,
    pub torch_version: Option<String>,
    pub cuda_version: Option<String>,
    pub gpu_name: Option<String>,
    pub model_directory: Option<String>,
    pub models_ready: bool,
    pub license_acknowledged: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiLayeringResult {
    pub job_id: String,
    pub file_name: String,
    pub bytes: u64,
    pub source_revision: String,
    pub layerdiff_revision: String,
    pub marigold_revision: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiResultChunk {
    pub offset: u64,
    pub total_size: u64,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiProgress {
    task_id: String,
    task: String,
    progress: u8,
    message: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PythonEnvironment {
    python_version: String,
    is_virtual_environment: bool,
    torch_version: String,
    cuda_version: String,
    gpu_name: String,
    cuda_available: bool,
    missing_packages: Vec<String>,
}

fn ai_data_root(app: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    let root = if std::env::var("IB_DEV_MODE").ok().as_deref() == Some("1") {
        super::validated_dev_sandbox_root()?.join("tauri-app-data")
    } else {
        app.path().app_data_dir().map_err(|_| "PUPPET_AI_STORAGE_UNAVAILABLE")?
    };
    #[cfg(not(debug_assertions))]
    let root = app.path().app_data_dir().map_err(|_| "PUPPET_AI_STORAGE_UNAVAILABLE")?;
    let path = root.join("live2d").join("puppet-ai");
    fs::create_dir_all(&path).map_err(|_| "PUPPET_AI_STORAGE_UNAVAILABLE")?;
    Ok(path)
}

fn registry_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(ai_data_root(app)?.join("registry.json"))
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("PUPPET_AI_PATH_INVALID")?;
    fs::create_dir_all(parent).map_err(|_| "PUPPET_AI_STORAGE_UNAVAILABLE")?;
    let temp = parent.join(format!(".{}.{}.tmp", Uuid::new_v4(), path.file_name().unwrap_or_default().to_string_lossy()));
    let result = (|| {
        let mut file = OpenOptions::new().write(true).create_new(true).open(&temp)
            .map_err(|_| "PUPPET_AI_STORAGE_WRITE_FAILED")?;
        file.write_all(bytes).map_err(|_| "PUPPET_AI_STORAGE_WRITE_FAILED")?;
        file.sync_all().map_err(|_| "PUPPET_AI_STORAGE_WRITE_FAILED")?;
        fs::rename(&temp, path).map_err(|_| "PUPPET_AI_STORAGE_WRITE_FAILED")?;
        Ok(())
    })();
    if result.is_err() { let _ = fs::remove_file(&temp); }
    result
}

fn selected_registry(app: &AppHandle) -> Result<Option<AiRegistry>, String> {
    let path = registry_path(app)?;
    let raw = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("PUPPET_AI_REGISTRY_READ_FAILED".to_string()),
    };
    let registry: AiRegistry = serde_json::from_slice(&raw).map_err(|_| "PUPPET_AI_REGISTRY_INVALID")?;
    if registry.schema != AI_REGISTRY_SCHEMA { return Err("PUPPET_AI_REGISTRY_INVALID".to_string()); }
    Ok(Some(registry))
}

fn load_component(app: &AppHandle) -> Result<Option<AiComponentManifest>, String> {
    let Some(registry) = selected_registry(app)? else { return Ok(None); };
    let directory = PathBuf::from(registry.component_directory);
    let manifest_path = directory.join("component.json");
    let raw = match fs::read(manifest_path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("PUPPET_AI_COMPONENT_READ_FAILED".to_string()),
    };
    let manifest: AiComponentManifest = serde_json::from_slice(&raw).map_err(|_| "PUPPET_AI_COMPONENT_INVALID")?;
    if manifest.schema != AI_COMPONENT_SCHEMA || PathBuf::from(&manifest.component_directory) != directory {
        return Err("PUPPET_AI_COMPONENT_INVALID".to_string());
    }
    Ok(Some(manifest))
}

fn canonical_dir(raw: &str, error: &'static str) -> Result<PathBuf, String> {
    let path = PathBuf::from(raw).canonicalize().map_err(|_| error)?;
    if !path.is_dir() { return Err(error.to_string()); }
    Ok(path)
}

fn canonical_file(raw: &str, error: &'static str) -> Result<PathBuf, String> {
    let path = PathBuf::from(raw).canonicalize().map_err(|_| error)?;
    if !path.is_file() { return Err(error.to_string()); }
    Ok(path)
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|_| "PUPPET_AI_SOURCE_NOT_FOUND")?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|_| "PUPPET_AI_SOURCE_READ_FAILED")?;
        if read == 0 { break; }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn current_revision(source: &Path) -> String {
    safe_command(Command::new("git"))
        .args(["-C", source.to_string_lossy().as_ref(), "rev-parse", "HEAD"])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .filter(|revision| !revision.is_empty())
        .unwrap_or_else(|| "unversioned-local-source".to_string())
}

fn python_environment(python: &Path, source: &Path, model_directory: &Path, component_directory: &Path) -> Result<PythonEnvironment, String> {
    let script = r#"import importlib.util,json,sys
required=['torch','diffusers','transformers','accelerate','huggingface_hub','bitsandbytes','cv2','PIL','psd_tools']
missing=[name for name in required if importlib.util.find_spec(name) is None]
result={'pythonVersion':sys.version.split()[0],'isVirtualEnvironment':sys.prefix!=sys.base_prefix,'torchVersion':'','cudaVersion':'','gpuName':'','cudaAvailable':False,'missingPackages':missing}
if not missing:
 import torch
 result['torchVersion']=torch.__version__
 result['cudaVersion']=str(torch.version.cuda or '')
 result['cudaAvailable']=bool(torch.cuda.is_available())
 if result['cudaAvailable']:
  result['gpuName']=torch.cuda.get_device_name(0)
print(json.dumps(result))"#;
    let output = safe_command(Command::new(python))
        .arg("-c").arg(script)
        .current_dir(source)
        .env("HF_HOME", model_directory)
        .env("HF_HUB_CACHE", hf_cache_root(model_directory))
        .env("HUGGINGFACE_HUB_CACHE", hf_cache_root(model_directory))
        .env("TORCH_HOME", model_directory.join("torch"))
        .env("XDG_CACHE_HOME", component_directory.join("cache"))
        .env("MPLCONFIGDIR", component_directory.join("cache").join("matplotlib"))
        .env("PYTHONPYCACHEPREFIX", component_directory.join("cache").join("pycache"))
        .env("PIP_CACHE_DIR", component_directory.join("cache").join("pip"))
        .env("TEMP", component_directory.join("cache").join("temp"))
        .env("TMP", component_directory.join("cache").join("temp"))
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .output().map_err(|_| "PUPPET_AI_PYTHON_LAUNCH_FAILED")?;
    if !output.status.success() { return Err("PUPPET_AI_DEPENDENCY_CHECK_FAILED".to_string()); }
    serde_json::from_slice(&output.stdout).map_err(|_| "PUPPET_AI_DEPENDENCY_CHECK_FAILED".to_string())
}

fn hf_cache_root(model_directory: &Path) -> PathBuf {
    if model_directory.join("models--24yearsold--seethroughv0.0.2_layerdiff3d_nf4").is_dir() {
        model_directory.to_path_buf()
    } else {
        model_directory.join("hub")
    }
}

fn model_cache_exists(cache: &Path, model: &str, revision: &str) -> bool {
    let folder = format!("models--{}", model.replace('/', "--"));
    cache.join(folder).join("snapshots").join(revision).is_dir()
}

fn cache_dir_for_install(component_directory: &Path) -> PathBuf {
    component_directory.join("cache").join("temp")
}

fn models_ready(model_directory: &Path) -> bool {
    let cache = hf_cache_root(model_directory);
    model_cache_exists(&cache, LAYERDIFF_MODEL, LAYERDIFF_REVISION)
        && model_cache_exists(&cache, MARIGOLD_MODEL, MARIGOLD_REVISION)
}

fn emit_progress(app: &AppHandle, task_id: &str, task: &str, progress: u8, message: impl Into<String>) {
    let _ = app.emit(AI_PROGRESS_EVENT, AiProgress {
        task_id: task_id.to_string(), task: task.to_string(), progress: progress.min(100),
        message: message.into().chars().take(240).collect(),
    });
}

fn safe_command(mut command: Command) -> Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

fn pump_child(
    app: &AppHandle,
    task_id: &str,
    task: &str,
    mut command: Command,
    log_path: &Path,
    progress: fn(&str) -> Option<(u8, &'static str)>,
) -> Result<(), String> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = safe_command(command).spawn().map_err(|_| "PUPPET_AI_PROCESS_START_FAILED")?;
    let stdout = child.stdout.take().ok_or("PUPPET_AI_PROCESS_START_FAILED")?;
    let stderr = child.stderr.take().ok_or("PUPPET_AI_PROCESS_START_FAILED")?;
    let (sender, receiver) = mpsc::channel::<String>();
    fn spawn_reader<R: Read + Send + 'static>(mut reader: R, sender: Sender<String>) -> thread::JoinHandle<()> {
        thread::spawn(move || {
            let mut bytes = [0u8; 4096];
            let mut line = Vec::new();
            loop {
                let count = match reader.read(&mut bytes) { Ok(0) | Err(_) => break, Ok(count) => count };
                for byte in &bytes[..count] {
                    if *byte == b'\n' || *byte == b'\r' {
                        if !line.is_empty() {
                            let text = String::from_utf8_lossy(&line).trim().to_string();
                            if !text.is_empty() && sender.send(text).is_err() { return; }
                            line.clear();
                        }
                    } else if line.len() < 2048 {
                        line.push(*byte);
                    }
                }
            }
            if !line.is_empty() { let _ = sender.send(String::from_utf8_lossy(&line).trim().to_string()); }
        })
    }
    let stdout_reader = spawn_reader(stdout, sender.clone());
    let stderr_reader = spawn_reader(stderr, sender);
    let mut output = VecDeque::new();
    let mut last_progress = 0u8;
    loop {
        match child.try_wait().map_err(|_| "PUPPET_AI_PROCESS_WAIT_FAILED")? {
            Some(status) => {
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                while let Ok(line) = receiver.try_recv() {
                    if let Some((percent, message)) = progress(&line) {
                        last_progress = last_progress.max(percent);
                        emit_progress(app, task_id, task, last_progress, message);
                    }
                    if !line.is_empty() { output.push_back(line); if output.len() > 600 { output.pop_front(); } }
                }
                if !status.success() {
                    let log = output.iter().cloned().collect::<Vec<_>>().join("\n");
                    let _ = fs::write(log_path, &log);
                    return Err(format!("PUPPET_AI_PROCESS_FAILED:{}", log.chars().rev().take(800).collect::<String>().chars().rev().collect::<String>()));
                }
                break;
            }
            None => {
                if let Ok(line) = receiver.recv_timeout(Duration::from_millis(250)) {
                    if let Some((percent, message)) = progress(&line) {
                        last_progress = last_progress.max(percent);
                        emit_progress(app, task_id, task, last_progress, message);
                    }
                    if !line.is_empty() { output.push_back(line); if output.len() > 600 { output.pop_front(); } }
                }
            }
        }
    }
    let log = output.into_iter().collect::<Vec<_>>().join("\n");
    fs::write(log_path, log).map_err(|_| "PUPPET_AI_LOG_WRITE_FAILED")?;
    Ok(())
}

fn model_download_progress(line: &str) -> Option<(u8, &'static str)> {
    if line.contains("IB_AI_MODEL_1_READY") { Some((60, "LayerDiff 权重已就绪")) }
    else if line.contains("IB_AI_MODEL_2_READY") { Some((80, "Marigold 权重已就绪")) }
    else if line.contains("IB_AI_MODEL_1_START") { Some((35, "准备 LayerDiff 权重")) }
    else if line.contains("IB_AI_MODEL_2_START") { Some((60, "准备 Marigold 权重")) }
    else { None }
}

fn dependency_install_progress(line: &str) -> Option<(u8, &'static str)> {
    if line.contains("Successfully installed") { Some((58, "See-through Python 依赖安装完成")) }
    else if line.contains("Installing collected packages") { Some((45, "正在安装 See-through 推理依赖")) }
    else if line.contains("Downloading") || line.contains("Collecting") { Some((30, "正在下载 CUDA PyTorch 和推理依赖")) }
    else { None }
}

#[cfg(windows)]
fn venv_python(directory: &Path) -> PathBuf { directory.join("Scripts").join("python.exe") }
#[cfg(not(windows))]
fn venv_python(directory: &Path) -> PathBuf { directory.join("bin").join("python") }

struct RemoveOnDrop(Option<PathBuf>);
impl Drop for RemoveOnDrop {
    fn drop(&mut self) {
        if let Some(path) = self.0.take() { let _ = fs::remove_dir_all(path); }
    }
}

fn path_free_bytes(python: &Path, path: &Path) -> Result<u64, String> {
    let script = "import json,shutil,sys; print(json.dumps({'free':shutil.disk_usage(sys.argv[1]).free}))";
    let output = safe_command(Command::new(python)).arg("-c").arg(script).arg(path).output()
        .map_err(|_| "PUPPET_AI_DISK_CHECK_FAILED")?;
    if !output.status.success() { return Err("PUPPET_AI_DISK_CHECK_FAILED".to_string()); }
    let value: Value = serde_json::from_slice(&output.stdout).map_err(|_| "PUPPET_AI_DISK_CHECK_FAILED")?;
    value.get("free").and_then(Value::as_u64).ok_or_else(|| "PUPPET_AI_DISK_CHECK_FAILED".to_string())
}

fn infer_progress(line: &str) -> Option<(u8, &'static str)> {
    if line.contains("LayerDiff3D done") { Some((62, "See-through 图层推理完成")) }
    else if line.contains("Running LayerDiff3D") { Some((24, "正在生成透明角色图层")) }
    else if line.contains("Building LayerDiff3D") { Some((12, "正在载入 LayerDiff 模型")) }
    else if line.contains("Marigold done") { Some((88, "深度估计完成")) }
    else if line.contains("Running Marigold") { Some((72, "正在估计图层深度")) }
    else if line.contains("Building Marigold") { Some((66, "正在载入 Marigold 模型")) }
    else if line.contains("PSD assembly") || line.contains("Running PSD assembly") { Some((94, "正在写入分层 PSD")) }
    else { None }
}

#[tauri::command]
pub async fn ib_puppet_ai_pick_path(app: AppHandle, kind: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let selected = match kind.as_str() {
            "component" => app.dialog().file().set_title("选择 Puppet AI 组件目录").blocking_pick_folder(),
            "source" => app.dialog().file().set_title("选择 See-through 源码目录").blocking_pick_folder(),
            "models" => app.dialog().file().set_title("选择 AI 模型存储目录").blocking_pick_folder(),
            "python" => app.dialog().file().add_filter("Python", &["exe"]).set_title("选择隔离 Python 环境的 python.exe").blocking_pick_file(),
            _ => return Err("PUPPET_AI_PICKER_KIND_INVALID".to_string()),
        };
        selected.map(|path| path.into_path().map(|path| path.to_string_lossy().to_string()).map_err(|_| "PUPPET_AI_PICKER_PATH_INVALID".to_string())).transpose()
    }).await.map_err(|_| "PUPPET_AI_PICKER_FAILED".to_string())?
}

#[tauri::command]
pub fn ib_puppet_ai_status(app: AppHandle) -> Result<AiComponentStatus, String> {
    let Some(manifest) = load_component(&app)? else {
        return Ok(AiComponentStatus {
            installed: false, ready: false, version: None, component_directory: None,
            source_directory: None, source_revision: None, layerdiff_revision: None,
            marigold_revision: None, python_executable: None,
            managed_python_directory: None,
            python_version: None, torch_version: None, cuda_version: None, gpu_name: None,
            model_directory: None, models_ready: false, license_acknowledged: false,
            message: "未安装本地 AI 组件；上传立绘、导入 PSD 和手动分层仍可使用。".to_string(),
        });
    };
    let models = models_ready(Path::new(&manifest.model_directory));
    let source_exists = Path::new(&manifest.source_directory).join("inference/scripts/inference_psd_quantized.py").is_file();
    let python_exists = Path::new(&manifest.python_executable).is_file();
    let ready = models && source_exists && python_exists && manifest.license_acknowledged;
    Ok(AiComponentStatus {
        installed: true, ready, version: Some(manifest.version),
        component_directory: Some(manifest.component_directory), source_directory: Some(manifest.source_directory),
        source_revision: Some(manifest.source_revision), layerdiff_revision: Some(manifest.layerdiff_revision),
        marigold_revision: Some(manifest.marigold_revision), python_executable: Some(manifest.python_executable),
        managed_python_directory: manifest.managed_python_directory,
        python_version: Some(manifest.python_version), torch_version: Some(manifest.torch_version),
        cuda_version: Some(manifest.cuda_version), gpu_name: Some(manifest.gpu_name),
        model_directory: Some(manifest.model_directory), models_ready: models,
        license_acknowledged: manifest.license_acknowledged,
        message: if ready { "本地 See-through 组件已就绪；模型只从所选目录读取。".to_string() }
            else if !models { "组件已安装，但模型缺失；重新安装/修复可从官方 Hugging Face 仓库下载。".to_string() }
            else { "组件路径不可用；请检查源码目录和 Python 环境后重新安装。".to_string() },
    })
}

#[tauri::command]
pub async fn ib_puppet_ai_install(
    app: AppHandle,
    component_root: String,
    source_root: String,
    python_executable: String,
    model_directory: String,
    license_acknowledged: bool,
) -> Result<AiComponentStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        install_component(&app, component_root, source_root, python_executable, model_directory, license_acknowledged)
    }).await.map_err(|_| "PUPPET_AI_INSTALL_FAILED".to_string())?
}

fn install_component(
    app: &AppHandle,
    component_root: String,
    source_root: String,
    python_executable: String,
    model_directory: String,
    license_acknowledged: bool,
) -> Result<AiComponentStatus, String> {
    let task_id = Uuid::new_v4().to_string();
    if !license_acknowledged { return Err("PUPPET_AI_LICENSE_ACK_REQUIRED".to_string()); }
    emit_progress(app, &task_id, "install", 5, "验证本地源码、Python 和模型目录");
    let source = canonical_dir(&source_root, "PUPPET_AI_SOURCE_NOT_FOUND")?;
    let base_python = canonical_file(&python_executable, "PUPPET_AI_PYTHON_NOT_FOUND")?;
    let component_root = canonical_dir(&component_root, "PUPPET_AI_COMPONENT_DIRECTORY_UNAVAILABLE")?;
    let model_root = PathBuf::from(&model_directory);
    fs::create_dir_all(&model_root).map_err(|_| "PUPPET_AI_MODEL_DIRECTORY_UNAVAILABLE")?;
    let model_root = model_root.canonicalize().map_err(|_| "PUPPET_AI_MODEL_DIRECTORY_UNAVAILABLE")?;
    let inference_script = source.join("inference").join("scripts").join("inference_psd_quantized.py");
    if !inference_script.is_file() || !source.join("LICENSE").is_file() {
        return Err("PUPPET_AI_SOURCE_INVALID".to_string());
    }
    let component_dir = component_root.join("IB-Puppet-AI");
    fs::create_dir_all(component_dir.join("jobs")).map_err(|_| "PUPPET_AI_COMPONENT_DIRECTORY_UNAVAILABLE")?;
    fs::create_dir_all(component_dir.join("cache")).map_err(|_| "PUPPET_AI_COMPONENT_DIRECTORY_UNAVAILABLE")?;
    for cache in ["matplotlib", "pycache", "pip", "temp"] {
        fs::create_dir_all(component_dir.join("cache").join(cache)).map_err(|_| "PUPPET_AI_COMPONENT_DIRECTORY_UNAVAILABLE")?;
    }
    let component_dir = component_dir.canonicalize().map_err(|_| "PUPPET_AI_COMPONENT_DIRECTORY_UNAVAILABLE")?;
    emit_progress(app, &task_id, "install", 15, "检查隔离 Python 环境与 CUDA 依赖");
    let base_environment = python_environment(&base_python, &source, &model_root, &component_dir)?;
    if !base_environment.python_version.starts_with("3.12.") {
        return Err("PUPPET_AI_PYTHON_VERSION_UNSUPPORTED:3.12".to_string());
    }
    let mut python = base_python.clone();
    let mut environment = base_environment;
    let mut staged_venv_cleanup = RemoveOnDrop(None);
    let mut managed_python_directory = None;
    if !environment.is_virtual_environment || !environment.missing_packages.is_empty() || !environment.cuda_available {
        emit_progress(app, &task_id, "install", 20, "正在创建组件专属 Python venv，并按上游清单安装 CUDA 与推理依赖");
        if path_free_bytes(&base_python, &component_root)? < 12 * 1024 * 1024 * 1024 {
            return Err("PUPPET_AI_DEPENDENCY_DISK_SPACE_LOW".to_string());
        }
        let staging = component_dir.join(format!(".python-env-install-{}", Uuid::new_v4().simple()));
        staged_venv_cleanup.0 = Some(staging.clone());
        let mut create_venv = safe_command(Command::new(&base_python));
        create_venv.arg("-m").arg("venv").arg(&staging).current_dir(&source);
        let setup_log = component_dir.join("cache").join("python-install.log");
        pump_child(app, &task_id, "install", create_venv, &setup_log, dependency_install_progress)?;
        let staging_python = venv_python(&staging);
        if !staging_python.is_file() { return Err("PUPPET_AI_VENV_CREATE_FAILED".to_string()); }
        let pip_cache = component_dir.join("cache").join("pip");
        let install_temp = cache_dir_for_install(&component_dir);
        fs::create_dir_all(&pip_cache).map_err(|_| "PUPPET_AI_STORAGE_UNAVAILABLE")?;
        fs::create_dir_all(&install_temp).map_err(|_| "PUPPET_AI_STORAGE_UNAVAILABLE")?;
        let mut torch_install = safe_command(Command::new(&staging_python));
        torch_install.args(["-m", "pip", "install", "torch==2.8.0+cu128", "torchvision==0.23.0+cu128", "torchaudio==2.8.0+cu128", "--index-url", "https://download.pytorch.org/whl/cu128"])
            .current_dir(&source).env("PIP_CACHE_DIR", &pip_cache).env("TEMP", &install_temp)
            .env("TMP", &install_temp);
        pump_child(app, &task_id, "install", torch_install, &setup_log, dependency_install_progress)?;
        let mut dependencies = safe_command(Command::new(&staging_python));
        dependencies.args(["-m", "pip", "install", "-r"])
            .arg(source.join("requirements.txt"))
            .arg("-r").arg(source.join("requirements-inference-bnb.txt"))
            .current_dir(&source).env("PIP_CACHE_DIR", &pip_cache)
            .env("TEMP", &install_temp).env("TMP", &install_temp);
        pump_child(app, &task_id, "install", dependencies, &setup_log, dependency_install_progress)?;
        python = staging_python;
        environment = python_environment(&python, &source, &model_root, &component_dir)?;
        if !environment.missing_packages.is_empty() {
            return Err(format!("PUPPET_AI_DEPENDENCIES_MISSING:{}", environment.missing_packages.join(",")));
        }
        if !environment.cuda_available { return Err("PUPPET_AI_CUDA_REQUIRED".to_string()); }
    }
    emit_progress(app, &task_id, "install", 25, "检查并安装固定版本的本地模型");
    let cache = hf_cache_root(&model_root);
    let needs_models = !model_cache_exists(&cache, LAYERDIFF_MODEL, LAYERDIFF_REVISION)
        || !model_cache_exists(&cache, MARIGOLD_MODEL, MARIGOLD_REVISION);
    if needs_models {
        if path_free_bytes(&python, &model_root)? < MODEL_DOWNLOAD_RESERVE_BYTES {
            return Err("PUPPET_AI_MODEL_DISK_SPACE_LOW".to_string());
        }
        let download_script = r#"import sys
from huggingface_hub import snapshot_download
cache=sys.argv[1]
models=[('24yearsold/seethroughv0.0.2_layerdiff3d_nf4','96f9311ff449dc86cfaba101ce4dfb4fd4958b80'),('24yearsold/seethroughv0.0.1_marigold_nf4','e53b344b5aa5beec7c141bd5601decaaff0898c9')]
for index,(repo,revision) in enumerate(models,1):
 print(f'IB_AI_MODEL_{index}_START',flush=True)
 snapshot_download(repo_id=repo,revision=revision,cache_dir=cache)
 print(f'IB_AI_MODEL_{index}_READY',flush=True)
"#;
        let mut command = Command::new(&python);
        command.arg("-c").arg(download_script).arg(&cache).current_dir(&source)
            .env("HF_HOME", &model_root).env("HF_HUB_CACHE", &cache).env("HUGGINGFACE_HUB_CACHE", &cache)
            .env("PYTHONNOUSERSITE", "1");
        let log = ai_data_root(app)?.join("install-models.log");
        pump_child(app, &task_id, "install", command, &log, model_download_progress)?;
    } else {
        emit_progress(app, &task_id, "install", 80, "复用所选目录中已校验的模型权重");
    }
    if !models_ready(&model_root) { return Err("PUPPET_AI_MODELS_INCOMPLETE".to_string()); }
    emit_progress(app, &task_id, "install", 90, "记录组件版本、模型来源与许可证状态");
    let source_revision = current_revision(&source);
    let inference_sha256 = sha256_file(&inference_script)?;
    let installed_python = if staged_venv_cleanup.0.is_some() {
        let staging = staged_venv_cleanup.0.as_ref().unwrap().clone();
        let destination = component_dir.join(format!("python-env-{}", &Uuid::new_v4().simple().to_string()[..8]));
        fs::rename(&staging, &destination).map_err(|_| "PUPPET_AI_VENV_INSTALL_FAILED")?;
        staged_venv_cleanup.0 = Some(destination.clone());
        managed_python_directory = Some(destination.to_string_lossy().to_string());
        venv_python(&destination)
    } else { python.clone() };
    let manifest = AiComponentManifest {
        schema: AI_COMPONENT_SCHEMA.to_string(),
        version: "1.3.0".to_string(),
        component_directory: component_dir.to_string_lossy().to_string(),
        source_directory: source.to_string_lossy().to_string(),
        python_executable: installed_python.to_string_lossy().to_string(),
        managed_python_directory,
        model_directory: model_root.to_string_lossy().to_string(),
        source_revision,
        layerdiff_revision: LAYERDIFF_REVISION.to_string(),
        marigold_revision: MARIGOLD_REVISION.to_string(),
        inference_script_sha256: inference_sha256,
        python_version: environment.python_version,
        torch_version: environment.torch_version,
        cuda_version: environment.cuda_version,
        gpu_name: environment.gpu_name,
        license_acknowledged,
        installed_at: SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs().to_string(),
    };
    let manifest_bytes = serde_json::to_vec_pretty(&manifest).map_err(|_| "PUPPET_AI_COMPONENT_INVALID")?;
    write_atomic(&component_dir.join("component.json"), &manifest_bytes)?;
    let registry = AiRegistry { schema: AI_REGISTRY_SCHEMA.to_string(), component_directory: component_dir.to_string_lossy().to_string() };
    write_atomic(&registry_path(app)?, &serde_json::to_vec_pretty(&registry).map_err(|_| "PUPPET_AI_REGISTRY_INVALID")?)?;
    staged_venv_cleanup.0 = None;
    emit_progress(app, &task_id, "install", 100, "See-through 组件已安装并验证");
    ib_puppet_ai_status(app.clone())
}

#[tauri::command]
pub fn ib_puppet_ai_uninstall(app: AppHandle, remove_managed_environment: bool) -> Result<(), String> {
    let Some(manifest) = load_component(&app)? else { return Ok(()); };
    let component_dir = PathBuf::from(&manifest.component_directory).canonicalize().map_err(|_| "PUPPET_AI_COMPONENT_NOT_FOUND")?;
    let data_dir = ai_data_root(&app)?;
    let registry = registry_path(&app)?;
    if remove_managed_environment {
        if let Some(environment) = manifest.managed_python_directory.as_deref() {
            let environment = PathBuf::from(environment).canonicalize().map_err(|_| "PUPPET_AI_PATH_INVALID")?;
            if !environment.starts_with(&component_dir) || environment == component_dir || environment.is_symlink() {
                return Err("PUPPET_AI_PATH_REJECTED".to_string());
            }
            if environment.exists() { fs::remove_dir_all(environment).map_err(|_| "PUPPET_AI_STORAGE_CLEANUP_FAILED")?; }
        }
    }
    let _ = fs::remove_file(&component_dir.join("component.json"));
    if registry.exists() { fs::remove_file(registry).map_err(|_| "PUPPET_AI_STORAGE_CLEANUP_FAILED")?; }
    let _ = fs::remove_file(data_dir.join("install-models.log"));
    Ok(())
}

#[tauri::command]
pub fn ib_puppet_ai_clear_cache(app: AppHandle, remove_models: bool) -> Result<u64, String> {
    let manifest = load_component(&app)?.ok_or("PUPPET_AI_NOT_INSTALLED")?;
    let component_dir = PathBuf::from(&manifest.component_directory).canonicalize().map_err(|_| "PUPPET_AI_COMPONENT_NOT_FOUND")?;
    let cache_dir = component_dir.join("cache");
    if cache_dir.exists() {
        if !cache_dir.canonicalize().map_err(|_| "PUPPET_AI_PATH_INVALID")?.starts_with(&component_dir) {
            return Err("PUPPET_AI_PATH_REJECTED".to_string());
        }
        fs::remove_dir_all(&cache_dir).map_err(|_| "PUPPET_AI_STORAGE_CLEANUP_FAILED")?;
    }
    fs::create_dir_all(&cache_dir).map_err(|_| "PUPPET_AI_STORAGE_CLEANUP_FAILED")?;
    let mut removed = 0u64;
    if remove_models {
        let model_dir = PathBuf::from(&manifest.model_directory).canonicalize().map_err(|_| "PUPPET_AI_MODEL_DIRECTORY_UNAVAILABLE")?;
        let cache = hf_cache_root(&model_dir);
        for model in [LAYERDIFF_MODEL, MARIGOLD_MODEL] {
            let path = cache.join(format!("models--{}", model.replace('/', "--")));
            if path.exists() {
                if path.is_symlink() || !path.canonicalize().map_err(|_| "PUPPET_AI_PATH_INVALID")?.starts_with(&cache) {
                    return Err("PUPPET_AI_PATH_REJECTED".to_string());
                }
                let size = directory_bytes(&path)?;
                fs::remove_dir_all(&path).map_err(|_| "PUPPET_AI_STORAGE_CLEANUP_FAILED")?;
                removed = removed.saturating_add(size);
            }
        }
    }
    Ok(removed)
}

fn directory_bytes(path: &Path) -> Result<u64, String> {
    let mut total = 0u64;
    for entry in fs::read_dir(path).map_err(|_| "PUPPET_AI_CACHE_READ_FAILED")? {
        let entry = entry.map_err(|_| "PUPPET_AI_CACHE_READ_FAILED")?;
        let kind = entry.file_type().map_err(|_| "PUPPET_AI_CACHE_READ_FAILED")?;
        if kind.is_symlink() { continue; }
        if kind.is_dir() { total = total.saturating_add(directory_bytes(&entry.path())?); }
        else if kind.is_file() { total = total.saturating_add(entry.metadata().map_err(|_| "PUPPET_AI_CACHE_READ_FAILED")?.len()); }
    }
    Ok(total)
}

fn safe_stem(input: &str) -> String {
    let value = Path::new(input).file_stem().and_then(|name| name.to_str()).unwrap_or("puppet-input");
    let cleaned = value.chars().map(|ch| if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' { ch } else { '-' })
        .collect::<String>().trim_matches('-').to_string();
    if cleaned.is_empty() { "puppet-input".to_string() } else { cleaned.chars().take(48).collect() }
}

fn decode_image_data_url(value: &str) -> Result<(&'static str, &'static str, Vec<u8>), String> {
    let (header, encoded) = value.split_once(',').ok_or("PUPPET_AI_INPUT_INVALID")?;
    if !header.ends_with(";base64") { return Err("PUPPET_AI_INPUT_INVALID".to_string()); }
    let (mime, ext) = if header.eq_ignore_ascii_case("data:image/png;base64") { ("image/png", "png") }
        else if header.eq_ignore_ascii_case("data:image/jpeg;base64") { ("image/jpeg", "jpg") }
        else if header.eq_ignore_ascii_case("data:image/webp;base64") { ("image/webp", "webp") }
        else { return Err("PUPPET_AI_INPUT_TYPE_UNSUPPORTED".to_string()); };
    let bytes = BASE64_STANDARD.decode(encoded).map_err(|_| "PUPPET_AI_INPUT_INVALID")?;
    if bytes.is_empty() || bytes.len() > AI_INPUT_LIMIT_BYTES { return Err("PUPPET_AI_INPUT_LIMIT_EXCEEDED".to_string()); }
    let valid = match mime {
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "image/webp" => bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
        _ => false,
    };
    if !valid { return Err("PUPPET_AI_INPUT_INVALID".to_string()); }
    Ok((mime, ext, bytes))
}

#[tauri::command]
pub async fn ib_puppet_ai_run(
    app: AppHandle,
    source_data_url: String,
    input_name: String,
) -> Result<AiLayeringResult, String> {
    tauri::async_runtime::spawn_blocking(move || run_layering(&app, source_data_url, input_name))
        .await.map_err(|_| "PUPPET_AI_INFERENCE_FAILED".to_string())?
}

fn run_layering(app: &AppHandle, source_data_url: String, input_name: String) -> Result<AiLayeringResult, String> {
    let manifest = load_component(app)?.ok_or("PUPPET_AI_NOT_INSTALLED")?;
    if !models_ready(Path::new(&manifest.model_directory)) { return Err("PUPPET_AI_MODELS_MISSING".to_string()); }
    if !manifest.license_acknowledged { return Err("PUPPET_AI_LICENSE_ACK_REQUIRED".to_string()); }
    let (mime, extension, input_bytes) = decode_image_data_url(&source_data_url)?;
    let _ = mime;
    let job_id = Uuid::new_v4().to_string();
    let stem = safe_stem(&input_name);
    let component_dir = PathBuf::from(&manifest.component_directory).canonicalize().map_err(|_| "PUPPET_AI_COMPONENT_NOT_FOUND")?;
    let job_dir = component_dir.join("jobs").join(&job_id);
    let temp_dir = job_dir.join("tmp");
    let output_dir = job_dir.join("output");
    fs::create_dir_all(&temp_dir).map_err(|_| "PUPPET_AI_JOB_CREATE_FAILED")?;
    fs::create_dir_all(&output_dir).map_err(|_| "PUPPET_AI_JOB_CREATE_FAILED")?;
    let input_path = job_dir.join(format!("input.{extension}"));
    fs::write(&input_path, input_bytes).map_err(|_| "PUPPET_AI_JOB_CREATE_FAILED")?;
    let log_path = job_dir.join("inference.log");
    emit_progress(app, &job_id, "inference", 4, "本地任务已准备；图像不会上传到 Provider");
    let inference = PathBuf::from(&manifest.source_directory).join("inference").join("scripts").join("inference_psd_quantized.py");
    let model_dir = PathBuf::from(&manifest.model_directory);
    let model_cache = hf_cache_root(&model_dir);
    let cache_dir = component_dir.join("cache");
    let mut command = Command::new(&manifest.python_executable);
    command.arg(&inference)
        .arg("--srcp").arg(&input_path)
        .arg("--save_dir").arg(&output_dir)
        .args(["--seed", "42", "--resolution", "768", "--resolution_depth", "512", "--num_inference_steps", "30", "--save_to_psd", "--tblr_split", "--cpu_offload"])
        .current_dir(&manifest.source_directory)
        .env("HF_HOME", &model_dir).env("HF_HUB_CACHE", &model_cache).env("HUGGINGFACE_HUB_CACHE", &model_cache)
        .env("TORCH_HOME", model_dir.join("torch"))
        .env("TRANSFORMERS_CACHE", &model_cache).env("PIP_CACHE_DIR", cache_dir.join("pip"))
        .env("XDG_CACHE_HOME", &cache_dir).env("MPLCONFIGDIR", cache_dir.join("matplotlib"))
        .env("PYTHONPYCACHEPREFIX", cache_dir.join("pycache")).env("PYTHONDONTWRITEBYTECODE", "1")
        .env("TEMP", &temp_dir).env("TMP", &temp_dir).env("TMPDIR", &temp_dir).env("PYTHONNOUSERSITE", "1");
    let result = pump_child(app, &job_id, "inference", command, &log_path, infer_progress);
    if let Err(error) = result {
        emit_progress(app, &job_id, "inference", 0, "推理未完成；已保留部分输出、日志与源图供诊断");
        return Err(error);
    }
    let candidates = [output_dir.join(format!("{stem}.psd")), output_dir.join(&stem).join(format!("{stem}.psd"))];
    let output = candidates.into_iter().find(|path| path.is_file()).ok_or("PUPPET_AI_RESULT_MISSING")?;
    let metadata = fs::symlink_metadata(&output).map_err(|_| "PUPPET_AI_RESULT_MISSING")?;
    if metadata.file_type().is_symlink() || metadata.len() < 26 || metadata.len() > AI_RESULT_LIMIT_BYTES {
        return Err("PUPPET_AI_RESULT_INVALID".to_string());
    }
    let mut header = [0u8; 4];
    fs::File::open(&output).and_then(|mut file| file.read_exact(&mut header)).map_err(|_| "PUPPET_AI_RESULT_INVALID")?;
    if &header != b"8BPS" { return Err("PUPPET_AI_RESULT_INVALID".to_string()); }
    let result_path = job_dir.join("result.psd");
    fs::copy(&output, &result_path).map_err(|_| "PUPPET_AI_RESULT_WRITE_FAILED")?;
    let bytes = fs::metadata(&result_path).map_err(|_| "PUPPET_AI_RESULT_MISSING")?.len();
    emit_progress(app, &job_id, "inference", 100, "分层 PSD 已生成；可导入 Character Studio 逐层检查");
    Ok(AiLayeringResult {
        job_id,
        file_name: format!("{stem}.psd"),
        bytes,
        source_revision: manifest.source_revision,
        layerdiff_revision: LAYERDIFF_REVISION.to_string(),
        marigold_revision: MARIGOLD_REVISION.to_string(),
    })
}

#[tauri::command]
pub fn ib_puppet_ai_result_read_chunk(
    app: AppHandle,
    job_id: String,
    offset: u64,
    max_bytes: usize,
) -> Result<AiResultChunk, String> {
    if Uuid::parse_str(&job_id).is_err() { return Err("PUPPET_AI_JOB_NOT_FOUND".to_string()); }
    let manifest = load_component(&app)?.ok_or("PUPPET_AI_NOT_INSTALLED")?;
    let component = PathBuf::from(&manifest.component_directory).canonicalize().map_err(|_| "PUPPET_AI_COMPONENT_NOT_FOUND")?;
    let job = component.join("jobs").join(&job_id).canonicalize().map_err(|_| "PUPPET_AI_JOB_NOT_FOUND")?;
    if !job.starts_with(component.join("jobs")) { return Err("PUPPET_AI_PATH_REJECTED".to_string()); }
    let path = job.join("result.psd");
    let metadata = fs::symlink_metadata(&path).map_err(|_| "PUPPET_AI_RESULT_NOT_FOUND")?;
    if metadata.file_type().is_symlink() || metadata.len() > AI_RESULT_LIMIT_BYTES { return Err("PUPPET_AI_RESULT_INVALID".to_string()); }
    if max_bytes == 0 || max_bytes > AI_RESULT_CHUNK_BYTES || offset >= metadata.len() { return Err("PUPPET_AI_RESULT_CHUNK_INVALID".to_string()); }
    let count = (metadata.len() - offset).min(max_bytes as u64) as usize;
    let mut file = fs::File::open(path).map_err(|_| "PUPPET_AI_RESULT_NOT_FOUND")?;
    use std::io::{Seek, SeekFrom};
    file.seek(SeekFrom::Start(offset)).map_err(|_| "PUPPET_AI_RESULT_READ_FAILED")?;
    let mut bytes = vec![0u8; count];
    file.read_exact(&mut bytes).map_err(|_| "PUPPET_AI_RESULT_READ_FAILED")?;
    Ok(AiResultChunk { offset, total_size: metadata.len(), bytes })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_names_never_become_paths() {
        assert_eq!(safe_stem("../../DeepSeek 角色.png"), "DeepSeek");
        assert_eq!(safe_stem("C:\\temp\\portrait.PNG"), "portrait");
        assert_eq!(safe_stem("..."), "puppet-input");
    }

    #[test]
    fn ai_input_requires_an_image_signature_and_supported_mime() {
        let png = format!("data:image/png;base64,{}", BASE64_STANDARD.encode(b"\x89PNG\r\n\x1a\ninput"));
        assert_eq!(decode_image_data_url(&png).unwrap().0, "image/png");
        assert_eq!(decode_image_data_url("data:image/png;base64,aGVsbG8=").unwrap_err(), "PUPPET_AI_INPUT_INVALID");
        assert_eq!(decode_image_data_url("data:text/plain;base64,aGVsbG8=").unwrap_err(), "PUPPET_AI_INPUT_TYPE_UNSUPPORTED");
    }

    #[test]
    fn selected_hf_cache_is_detected_at_either_hf_home_or_hub_root() {
        let root = std::env::temp_dir().join(format!("ib-puppet-ai-cache-{}", Uuid::new_v4()));
        let hf_home = root.join("hf");
        let hub = hf_home.join("hub");
        let snapshot = hub.join("models--24yearsold--seethroughv0.0.2_layerdiff3d_nf4")
            .join("snapshots").join(LAYERDIFF_REVISION);
        fs::create_dir_all(&snapshot).unwrap();
        assert_eq!(hf_cache_root(&hf_home), hub);
        assert!(model_cache_exists(&hub, LAYERDIFF_MODEL, LAYERDIFF_REVISION));
        let _ = fs::remove_dir_all(root);
    }
}
