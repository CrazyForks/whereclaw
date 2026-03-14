use std::{
    collections::{hash_map::DefaultHasher, HashMap},
    env,
    ffi::{OsStr, OsString},
    fs,
    fs::OpenOptions,
    hash::{Hash, Hasher},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Child as StdChild, Command, Stdio},
    sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use portable_pty::{native_pty_system, Child as PtyChild, CommandBuilder, MasterPty, PtySize};
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sysinfo::{System, SystemExt};
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{path::BaseDirectory, AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use url::Url;
use zip::ZipArchive;

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
compile_error!("WhereClaw currently supports only Windows, macOS, and Linux targets.");

const CONTROL_UI_PORT: u16 = 18_789;
const OLLAMA_PORT: u16 = 11_434;
const OLLAMA_HOST: &str = "127.0.0.1:11434";
const CONTROL_UI_WINDOW_LABEL: &str = "control-ui";
const HEALTH_CHECK_ATTEMPTS: usize = 40;
const HEALTH_CHECK_DELAY_MS: u64 = 250;
const ZH_NPM_REGISTRY: &str = "https://registry.npmmirror.com";
const LAUNCHER_LOG_FILE_NAME: &str = "whereclaw.log";
const OLLAMA_LOG_FILE_NAME: &str = "ollama.log";
const GATEWAY_LOG_FILE_NAME: &str = "gateway.console.log";
const LAUNCHER_LOG_MAX_BYTES: u64 = 1_048_576;
const LAUNCHER_LOG_KEEP_FILES: usize = 5;
const SKILL_DOWNLOAD_URL_TEMPLATE: &str =
    "https://skillhub-1388575217.cos.ap-guangzhou.myqcloud.com/skills/{slug}.zip";
const REMOTE_SKILLS_MANIFEST_URL: &str = "https://r2.tolearn.cc/manifest.json";
const REMOTE_SKILLS_DIR_NAME: &str = "remote-skills";
const REMOTE_SKILLS_FILE_NAME: &str = "skills.json";
const REMOTE_SKILLS_METADATA_FILE_NAME: &str = "metadata.json";
const TRAY_ICON_ID: &str = "main";
const TRAY_MENU_SHOW_ID: &str = "tray_show";
const TRAY_MENU_QUIT_ID: &str = "tray_quit";

struct GatewayProcess {
    child: Box<dyn PtyChild + Send>,
    _master: Box<dyn MasterPty + Send>,
}

struct GatewayState {
    child: Arc<Mutex<Option<GatewayProcess>>>,
    current_port: Arc<Mutex<u16>>,
}

struct OllamaState {
    child: Arc<Mutex<Option<StdChild>>>,
}

struct LocalModelRunState {
    progress: Arc<Mutex<LocalModelRunProgress>>,
    pull_pid: Arc<Mutex<Option<u32>>>,
    stop_requested: Arc<Mutex<bool>>,
}

struct ExitIntentState {
    quitting: AtomicBool,
}

fn show_main_window(app: &AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };

    window
        .show()
        .map_err(|error| format!("failed to show main window: {error}"))?;
    let _ = window.unminimize();
    let _ = window.set_focus();
    Ok(())
}

fn request_explicit_exit(app: &AppHandle) {
    if let Some(exit_intent) = app.try_state::<ExitIntentState>() {
        exit_intent.quitting.store(true, Ordering::SeqCst);
    }
    app.exit(0);
}

fn install_tray(app: &AppHandle) -> Result<(), String> {
    let show_item = MenuItem::with_id(app, TRAY_MENU_SHOW_ID, "显示主窗口", true, None::<&str>)
        .map_err(|error| format!("failed to create tray show menu item: {error}"))?;
    let quit_item = MenuItem::with_id(app, TRAY_MENU_QUIT_ID, "退出", true, None::<&str>)
        .map_err(|error| format!("failed to create tray quit menu item: {error}"))?;
    let menu = Menu::with_items(app, &[&show_item, &quit_item])
        .map_err(|error| format!("failed to create tray menu: {error}"))?;

    let mut tray_builder = TrayIconBuilder::with_id(TRAY_ICON_ID).menu(&menu);
    if let Some(icon) = app.default_window_icon().cloned() {
        tray_builder = tray_builder.icon(Image::new(icon.rgba(), icon.width(), icon.height()));
    }

    tray_builder
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            TRAY_MENU_SHOW_ID => {
                let _ = show_main_window(app);
            }
            TRAY_MENU_QUIT_ID => {
                request_explicit_exit(app);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let _ = show_main_window(tray.app_handle());
            }
        })
        .build(app)
        .map_err(|error| format!("failed to build tray icon: {error}"))?;

    Ok(())
}

fn cleanup_processes_on_exit(app: &AppHandle) -> Result<(), String> {
    if let Some(gateway_state) = app.try_state::<GatewayState>() {
        let mut child_slot = gateway_state
            .child
            .lock()
            .map_err(|_| String::from("failed to acquire gateway state lock during exit"))?;

        let running_pid = child_slot.as_mut().map(|process| process.child.process_id());

        if let Some(mut process) = child_slot.take() {
            process
                .child
                .kill()
                .map_err(|error| format!("failed to stop gateway process during exit: {error}"))?;
            let _ = process.child.wait();
        }

        if let Some(window) = app.get_webview_window(CONTROL_UI_WINDOW_LABEL) {
            let _ = window.close();
        }

        let _ = append_launcher_log(
            app,
            "INFO",
            &format!("exit cleanup completed for gateway pid={running_pid:?}"),
        );
    }

    if let Some(ollama_state) = app.try_state::<OllamaState>() {
        let mut child_slot = ollama_state
            .child
            .lock()
            .map_err(|_| String::from("failed to acquire ollama state lock during exit"))?;

        let running_pid = child_slot.as_ref().map(StdChild::id);

        if let Some(mut process) = child_slot.take() {
            process
                .kill()
                .map_err(|error| format!("failed to stop ollama process during exit: {error}"))?;
            let _ = process.wait();
        }

        let _ = append_launcher_log(
            app,
            "INFO",
            &format!("exit cleanup completed for ollama pid={running_pid:?}"),
        );
    }

    Ok(())
}

#[derive(Clone, Serialize)]
struct GatewayStatus {
    running: bool,
    pid: Option<u32>,
    url: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SetupInfo {
    configured: bool,
    openclaw_home: String,
    config_path: String,
    current_model_ref: String,
    current_model_name: String,
    current_model_provider: String,
    current_model_is_local: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OllamaStatus {
    running: bool,
    pid: Option<u32>,
    url: String,
    models_dir: String,
    version: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalModelRunProgress {
    running: bool,
    downloading: bool,
    has_known_progress: bool,
    progress: f32,
    completed_bytes: Option<u64>,
    total_bytes: Option<u64>,
    speed_bytes_per_sec: Option<f64>,
    model: String,
    message: String,
    success: bool,
    error: Option<String>,
}

impl Default for LocalModelRunProgress {
    fn default() -> Self {
        Self {
            running: false,
            downloading: false,
            has_known_progress: false,
            progress: 0.0,
            completed_bytes: None,
            total_bytes: None,
            speed_bytes_per_sec: None,
            model: String::new(),
            message: String::new(),
            success: false,
            error: None,
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemMemoryInfo {
    total_ram_bytes: u64,
    gpu_total_bytes: Option<u64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstalledSkillEntry {
    id: String,
    skill_key: String,
    title: String,
    description: Option<String>,
    source: String,
    path: String,
    has_references: bool,
    has_scripts: bool,
    enabled: bool,
}


#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BundledVersionManifest {
    skills_catalog_version: String,
}

#[derive(Clone, Deserialize)]
struct RemoteManifest {
    skills: Option<RemoteSkillsManifest>,
    desktop: Option<RemoteDesktopManifest>,
    notifications: Option<RemoteNotificationsManifest>,
}

#[derive(Clone, Deserialize)]
struct RemoteSkillsManifest {
    version: String,
    url: String,
}

#[derive(Clone, Deserialize)]
struct RemoteDesktopManifest {
    version: String,
}

#[derive(Clone, Deserialize)]
struct RemoteNotificationsManifest {
    #[serde(default)]
    cn: Vec<String>,
    #[serde(default)]
    en: Vec<String>,
}

#[derive(Clone, Serialize, Deserialize)]
struct CachedSkillCatalogMetadata {
    version: String,
    url: String,
    #[serde(default)]
    desktop_version: Option<String>,
    #[serde(default = "empty_cached_notifications")]
    notifications: CachedNotifications,
}

#[derive(Clone, Serialize, Deserialize)]
struct CachedNotifications {
    cn: Vec<String>,
    en: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ActiveSkillCatalogPayload {
    version: String,
    source: String,
    catalog: Value,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SkillCatalogRefreshResult {
    version: String,
    source: String,
    updated: bool,
    desktop_version: Option<String>,
    desktop_update_available: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteNotificationsPayload {
    cn: Vec<String>,
    en: Vec<String>,
    source: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteDesktopVersionPayload {
    version: Option<String>,
    update_available: bool,
    source: String,
}

fn collect_system_memory_info() -> Result<SystemMemoryInfo, String> {
    let mut system = System::new();
    system.refresh_memory();
    let total_ram_bytes = system.total_memory();
    let gpu_total_bytes = collect_gpu_total_bytes();
    Ok(SystemMemoryInfo {
        total_ram_bytes,
        gpu_total_bytes,
    })
}


fn parse_bundled_version_manifest() -> Result<BundledVersionManifest, String> {
    serde_json::from_str(include_str!("../../VERSION.json"))
        .map_err(|error| format!("failed to parse bundled VERSION.json: {error}"))
}

fn read_bundled_skill_catalog() -> Result<ActiveSkillCatalogPayload, String> {
    let version_manifest = parse_bundled_version_manifest()?;
    let catalog = serde_json::from_str(include_str!("../../skills.json"))
        .map_err(|error| format!("failed to parse bundled skills.json: {error}"))?;

    Ok(ActiveSkillCatalogPayload {
        version: version_manifest.skills_catalog_version,
        source: String::from("bundled"),
        catalog,
    })
}

fn current_desktop_version(app: &AppHandle) -> String {
    app.package_info().version.to_string()
}

fn is_remote_desktop_version_newer(
    remote_version: Option<&str>,
    current_version: &str,
) -> bool {
    let Some(remote_version) = remote_version.map(str::trim).filter(|value| !value.is_empty()) else {
        return false;
    };

    is_remote_version_newer(remote_version, current_version).unwrap_or(false)
}

fn empty_cached_notifications() -> CachedNotifications {
    CachedNotifications {
        cn: Vec::new(),
        en: Vec::new(),
    }
}

fn parse_semver_triplet(version: &str) -> Result<(u64, u64, u64), String> {
    let normalized = version
        .trim()
        .split_once('-')
        .map(|(value, _)| value)
        .unwrap_or(version.trim())
        .split_once('+')
        .map(|(value, _)| value)
        .unwrap_or(version.trim());
    let mut parts = normalized.split('.');
    let major = parts
        .next()
        .ok_or_else(|| format!("invalid semver version: {version}"))?
        .parse::<u64>()
        .map_err(|error| format!("invalid semver major component in {version}: {error}"))?;
    let minor = parts
        .next()
        .ok_or_else(|| format!("invalid semver version: {version}"))?
        .parse::<u64>()
        .map_err(|error| format!("invalid semver minor component in {version}: {error}"))?;
    let patch = parts
        .next()
        .ok_or_else(|| format!("invalid semver version: {version}"))?
        .parse::<u64>()
        .map_err(|error| format!("invalid semver patch component in {version}: {error}"))?;

    if parts.next().is_some() {
        return Err(format!("invalid semver version: {version}"));
    }

    Ok((major, minor, patch))
}

fn is_remote_version_newer(remote: &str, current: &str) -> Result<bool, String> {
    Ok(parse_semver_triplet(remote)? > parse_semver_triplet(current)?)
}

#[cfg(target_os = "macos")]
fn collect_gpu_total_bytes() -> Option<u64> {
    let output = Command::new("system_profiler")
        .args(["SPDisplaysDataType", "-json"])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let json: Value = serde_json::from_slice(&output.stdout).ok()?;
    let displays = json.get("SPDisplaysDataType")?.as_array()?;
    let mut max_bytes = None;

    for entry in displays {
        if let Some(object) = entry.as_object() {
            for (key, value) in object {
                if !is_gpu_memory_key(key) {
                    continue;
                }
                if let Some(text) = value.as_str() {
                    if let Some(bytes) = parse_memory_string(text) {
                        if max_bytes.map_or(true, |current| bytes > current) {
                            max_bytes = Some(bytes);
                        }
                    }
                }
            }
        }
    }

    max_bytes
}

#[cfg(target_os = "windows")]
fn collect_gpu_total_bytes() -> Option<u64> {
    let output = Command::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty AdapterRAM | Sort-Object -Descending | Select-Object -First 1",
        ])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .filter_map(|line| line.parse::<u64>().ok())
        .next()
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn collect_gpu_total_bytes() -> Option<u64> {
    None
}

#[cfg(target_os = "macos")]
fn is_gpu_memory_key(key: &str) -> bool {
    let normalized = key.to_ascii_lowercase();
    normalized.contains("vram")
        || normalized.contains("memory")
        || normalized.contains("mem")
        || normalized.contains("unified")
}

fn parse_memory_string(value: &str) -> Option<u64> {
    let mut number = String::new();
    let mut unit = String::new();
    let mut saw_digit = false;
    let mut unit_started = false;

    for c in value.chars() {
        if !unit_started && (c.is_ascii_digit() || c == '.') {
            number.push(c);
            saw_digit = true;
            continue;
        }

        if saw_digit && !unit_started {
            if c.is_whitespace() || c == ',' || c == '_' {
                continue;
            }
            if c.is_ascii_alphabetic() {
                unit_started = true;
                unit.push(c);
                continue;
            }
            break;
        }

        if unit_started {
            if c.is_ascii_alphabetic() {
                unit.push(c);
                continue;
            }
            break;
        }
    }

    if number.is_empty() {
        return None;
    }

    if unit.is_empty() {
        return None;
    }

    let parsed_number: f64 = number.parse().ok()?;
    let multiplier = match unit.chars().next().map(|c| c.to_ascii_lowercase()) {
        Some('t') => 1u64 << 40,
        Some('g') => 1u64 << 30,
        Some('m') => 1u64 << 20,
        Some('k') => 1u64 << 10,
        _ => 1,
    };

    Some((parsed_number * multiplier as f64) as u64)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LauncherPreferences {
    language: String,
    install_dir: String,
    has_saved_preferences: bool,
    is_initialized: bool,
    is_initialization_in_progress: bool,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredLauncherPreferences {
    language: String,
    install_dir: String,
    #[serde(default)]
    is_initialized: bool,
    #[serde(default)]
    is_initialization_in_progress: bool,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InitialQqChannelConfig {
    app_id: String,
    app_secret: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InitialSetupConfigRequest {
    local_model: Option<String>,
    qq: Option<InitialQqChannelConfig>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChannelAccount {
    channel: String,
    account_id: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelCatalogEntry {
    key: String,
    provider: String,
    model_id: String,
    name: String,
    input: Option<String>,
    context_window: Option<u64>,
    local: bool,
    available: bool,
    tags: Vec<String>,
    missing: bool,
    is_current: bool,
}

#[tauri::command]
async fn start_gateway(
    app: AppHandle,
    state: tauri::State<'_, GatewayState>,
) -> Result<GatewayStatus, String> {
    let app = app.clone();
    let child = state.child.clone();
    let current_port = state.current_port.clone();
    tauri::async_runtime::spawn_blocking(move || start_gateway_impl(&app, &child, &current_port))
        .await
        .map_err(|error| format!("failed to join gateway startup task: {error}"))?
}

#[tauri::command]
async fn stop_gateway(
    app: AppHandle,
    state: tauri::State<'_, GatewayState>,
) -> Result<GatewayStatus, String> {
    let app = app.clone();
    let child = state.child.clone();
    let current_port = state.current_port.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut child_slot = child
            .lock()
            .map_err(|_| String::from("failed to acquire gateway state lock"))?;
        let running_pid = child_slot
            .as_mut()
            .map(|process| process.child.process_id());

        if let Some(mut process) = child_slot.take() {
            process
                .child
                .kill()
                .map_err(|error| format!("failed to stop gateway process: {error}"))?;
            let _ = process.child.wait();
        }

        if let Some(window) = app.get_webview_window(CONTROL_UI_WINDOW_LABEL) {
            let _ = window.close();
        }

        let _port = *current_port
            .lock()
            .map_err(|_| String::from("failed to acquire gateway port state lock"))?;
        let _ = append_launcher_log(
            &app,
            "INFO",
            &format!("stop_gateway completed pid={running_pid:?}"),
        );

        Ok(GatewayStatus {
            running: false,
            pid: None,
            url: resolve_control_ui_url(&app)?,
        })
    })
    .await
    .map_err(|error| format!("failed to join gateway shutdown task: {error}"))?
}

#[tauri::command]
async fn gateway_status(
    app: AppHandle,
    state: tauri::State<'_, GatewayState>,
) -> Result<GatewayStatus, String> {
    let child = state.child.clone();
    let current_port = state.current_port.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut child_slot = child
            .lock()
            .map_err(|_| String::from("failed to acquire gateway state lock"))?;
        let _port = *current_port
            .lock()
            .map_err(|_| String::from("failed to acquire gateway port state lock"))?;

        if let Some(process) = child_slot.as_mut() {
            if process
                .child
                .try_wait()
                .map_err(|error| format!("failed to inspect gateway process state: {error}"))?
                .is_none()
            {
                return Ok(GatewayStatus {
                    running: true,
                    pid: process.child.process_id(),
                    url: resolve_control_ui_url(&app)?,
                });
            }

            *child_slot = None;
        }

        Ok(GatewayStatus {
            running: false,
            pid: None,
            url: resolve_control_ui_url(&app)?,
        })
    })
    .await
    .map_err(|error| format!("failed to join gateway status task: {error}"))?
}

#[tauri::command]
async fn start_ollama(
    app: AppHandle,
    state: tauri::State<'_, OllamaState>,
) -> Result<OllamaStatus, String> {
    let app = app.clone();
    let child = state.child.clone();
    tauri::async_runtime::spawn_blocking(move || start_ollama_impl(&app, &child))
        .await
        .map_err(|error| format!("failed to join ollama startup task: {error}"))?
}

#[tauri::command]
async fn stop_ollama(
    app: AppHandle,
    state: tauri::State<'_, OllamaState>,
) -> Result<OllamaStatus, String> {
    let app = app.clone();
    let child = state.child.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut child_slot = child
            .lock()
            .map_err(|_| String::from("failed to acquire ollama state lock"))?;

        if let Some(mut process) = child_slot.take() {
            process
                .kill()
                .map_err(|error| format!("failed to stop ollama process: {error}"))?;
            let _ = process.wait();
        }

        let mut stopped = false;
        for _ in 0..10 {
            stop_all_ollama_processes()?;
            thread::sleep(Duration::from_millis(220));
            if !is_ollama_reachable() {
                stopped = true;
                break;
            }
        }

        if !stopped {
            return Err(String::from(
                "Ollama is still reachable at http://127.0.0.1:11434/ after stop.",
            ));
        }

        build_ollama_status(&app, None, false)
    })
    .await
    .map_err(|error| format!("failed to join ollama shutdown task: {error}"))?
}

#[tauri::command]
async fn ollama_status(
    app: AppHandle,
    state: tauri::State<'_, OllamaState>,
) -> Result<OllamaStatus, String> {
    let app = app.clone();
    let child = state.child.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut child_slot = child
            .lock()
            .map_err(|_| String::from("failed to acquire ollama state lock"))?;

        if let Some(process) = child_slot.as_mut() {
            if process
                .try_wait()
                .map_err(|error| format!("failed to inspect ollama process state: {error}"))?
                .is_none()
            {
                return build_ollama_status(&app, Some(process.id()), true);
            }

            *child_slot = None;
        }

        if is_ollama_reachable() {
            return build_ollama_status(&app, None, true);
        }

        build_ollama_status(&app, None, false)
    })
    .await
    .map_err(|error| format!("failed to join ollama status task: {error}"))?
}

#[tauri::command]
async fn pull_ollama_model(
    app: AppHandle,
    state: tauri::State<'_, OllamaState>,
    model: String,
) -> Result<String, String> {
    let app = app.clone();
    let child = state.child.clone();
    tauri::async_runtime::spawn_blocking(move || pull_ollama_model_impl(&app, &child, &model))
        .await
        .map_err(|error| format!("failed to join ollama model pull task: {error}"))?
}

#[tauri::command]
async fn list_ollama_models(
    app: AppHandle,
    state: tauri::State<'_, OllamaState>,
) -> Result<Vec<String>, String> {
    let app = app.clone();
    let child = state.child.clone();
    tauri::async_runtime::spawn_blocking(move || list_ollama_models_impl(&app, &child))
        .await
        .map_err(|error| format!("failed to join ollama list models task: {error}"))?
}

#[tauri::command]
async fn check_local_model_exists(
    app: AppHandle,
    state: tauri::State<'_, OllamaState>,
    model: String,
) -> Result<bool, String> {
    let app = app.clone();
    let child = state.child.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let normalized_model = normalize_ollama_model_name_for_lookup(&model);
        if normalized_model.is_empty() {
            return Ok(false);
        }
        let models = list_ollama_models_impl(&app, &child)?;
        Ok(models.iter().any(|existing| {
            normalize_ollama_model_name_for_lookup(existing) == normalized_model
        }))
    })
    .await
    .map_err(|error| format!("failed to join local-model-exists task: {error}"))?
}

#[tauri::command]
fn start_local_model_run(
    app: AppHandle,
    ollama_state: tauri::State<'_, OllamaState>,
    model_run_state: tauri::State<'_, LocalModelRunState>,
    model: String,
) -> Result<(), String> {
    let normalized_model = normalize_and_validate_ollama_model_name(&model)?.to_string();

    let progress_state = model_run_state.progress.clone();
    {
        let mut progress = progress_state
            .lock()
            .map_err(|_| String::from("failed to acquire local model progress lock"))?;
        if progress.running {
            return Err(String::from(
                "a local model run task is already in progress",
            ));
        }

        *progress = LocalModelRunProgress {
            running: true,
            downloading: false,
            has_known_progress: false,
            progress: 0.0,
            completed_bytes: None,
            total_bytes: None,
            speed_bytes_per_sec: None,
            model: normalized_model.clone(),
            message: format!("Preparing model `{normalized_model}`..."),
            success: false,
            error: None,
        };
    }

    if let Ok(mut stop_requested) = model_run_state.stop_requested.lock() {
        *stop_requested = false;
    }
    if let Ok(mut pull_pid) = model_run_state.pull_pid.lock() {
        *pull_pid = None;
    }

    let app = app.clone();
    let child = ollama_state.child.clone();
    let progress_state_for_task = progress_state.clone();
    let pull_pid_state = model_run_state.pull_pid.clone();
    let stop_requested_state = model_run_state.stop_requested.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let outcome = run_local_model_workflow_impl(
            &app,
            &child,
            &progress_state_for_task,
            &pull_pid_state,
            &normalized_model,
        );

        let stop_requested = stop_requested_state
            .lock()
            .map(|flag| *flag)
            .unwrap_or(false);
        if let Ok(mut pull_pid) = pull_pid_state.lock() {
            *pull_pid = None;
        }

        if let Ok(mut progress) = progress_state_for_task.lock() {
            if stop_requested {
                *progress = LocalModelRunProgress::default();
                return;
            }
            progress.running = false;
            progress.downloading = false;
            match outcome {
                Ok(message) => {
                    progress.success = true;
                    progress.error = None;
                    progress.has_known_progress = false;
                    progress.progress = 0.0;
                    progress.completed_bytes = None;
                    progress.total_bytes = None;
                    progress.speed_bytes_per_sec = None;
                    progress.message = message;
                }
                Err(error) => {
                    progress.success = false;
                    progress.error = Some(error.clone());
                    progress.message = error;
                }
            }
        }
    });

    Ok(())
}

#[tauri::command]
fn get_local_model_run_progress(
    state: tauri::State<'_, LocalModelRunState>,
) -> Result<LocalModelRunProgress, String> {
    state
        .progress
        .lock()
        .map_err(|_| String::from("failed to acquire local model progress lock"))
        .map(|progress| progress.clone())
}

#[tauri::command]
fn stop_local_model_run(state: tauri::State<'_, LocalModelRunState>) -> Result<(), String> {
    let pid = state
        .pull_pid
        .lock()
        .map_err(|_| String::from("failed to acquire local model pull pid lock"))?
        .to_owned();

    let Some(pid) = pid else {
        return Ok(());
    };

    kill_process_by_pid(pid)?;

    if let Ok(mut stop_requested) = state.stop_requested.lock() {
        *stop_requested = true;
    }
    if let Ok(mut pull_pid) = state.pull_pid.lock() {
        *pull_pid = None;
    }
    if let Ok(mut progress) = state.progress.lock() {
        *progress = LocalModelRunProgress::default();
    }

    Ok(())
}

#[tauri::command]
fn open_control_ui_window(app: AppHandle) -> Result<(), String> {
    let control_ui_url = resolve_control_ui_url(&app)?;

    if let Some(window) = app.get_webview_window(CONTROL_UI_WINDOW_LABEL) {
        window
            .navigate(control_ui_url.parse().map_err(|error| {
                format!("failed to parse Control UI url for existing webview window: {error}")
            })?)
            .map_err(|error| format!("failed to navigate Control UI window: {error}"))?;
        window
            .set_focus()
            .map_err(|error| format!("failed to focus Control UI window: {error}"))?;
        return Ok(());
    }

    let launcher_preferences = read_launcher_preferences_impl(&app)?;
    let initialization_script =
        control_ui_window_initialization_script(&launcher_preferences.language)?;

    WebviewWindowBuilder::new(
        &app,
        CONTROL_UI_WINDOW_LABEL,
        WebviewUrl::External(control_ui_url.parse().map_err(|error| {
            format!("failed to parse Control UI url for webview window: {error}")
        })?),
    )
    .title("OpenClaw Control UI")
    .inner_size(1440.0, 920.0)
    .resizable(true)
    .focused(true)
    .initialization_script(&initialization_script)
    .build()
    .map_err(|error| format!("failed to create Control UI window: {error}"))?;

    Ok(())
}

#[tauri::command]
fn open_control_ui_in_browser(app: AppHandle) -> Result<(), String> {
    webbrowser::open(&resolve_control_ui_url(&app)?)
        .map(|_| ())
        .map_err(|error| format!("failed to open browser: {error}"))
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let parsed = Url::parse(&url).map_err(|error| format!("invalid url: {error}"))?;
    let scheme = parsed.scheme();
    if scheme != "http" && scheme != "https" {
        return Err(String::from("only http/https urls are allowed"));
    }

    webbrowser::open(parsed.as_str())
        .map(|_| ())
        .map_err(|error| format!("failed to open browser: {error}"))
}

#[tauri::command]
fn open_openclaw_config_file(app: AppHandle) -> Result<(), String> {
    let engine_dir = resolve_engine_dir(&app)?;
    let openclaw_home = initialize_openclaw_home(&app, &engine_dir)?;
    let config_path = openclaw_home.join("openclaw.json");

    if !config_path.exists() {
        return Err(format!(
            "OpenClaw config file does not exist: {}",
            config_path.display()
        ));
    }

    let _ = append_launcher_log(
        &app,
        "INFO",
        &format!("open_openclaw_config_file path={}", config_path.display()),
    );
    open_path_in_default_app(&config_path)
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn whereclaw_cmd_escape(value: &str) -> String {
    value.replace('^', "^^")
}

fn whereclaw_terminal_hint_message() -> &'static str {
    "Bundled commands: node, npm, npx, openclaw, ollama"
}

fn build_whereclaw_terminal_openclaw_wrapper_script(node_binary: &str, entry_script: &str) -> String {
    format!(
        "#!/bin/zsh
\"{node}\" \"{entry}\" \"$@\"
",
        node = node_binary,
        entry = entry_script,
    )
}

fn build_whereclaw_terminal_ollama_wrapper_script(
    ollama_binary: &str,
    ollama_models_dir: &str,
) -> String {
    format!(
        "#!/bin/zsh
export OLLAMA_HOST={host}
export OLLAMA_MODELS={models}
\"{binary}\" \"$@\"
",
        host = shell_single_quote(OLLAMA_HOST),
        models = shell_single_quote(ollama_models_dir),
        binary = ollama_binary,
    )
}

fn build_whereclaw_terminal_shell_rc(
    openclaw_home: &str,
    config_path: &str,
    tmp_dir: &str,
    npm_cache_dir: &str,
    npm_prefix_dir: &str,
    corepack_home_dir: &str,
    terminal_bin_dir: &str,
    runtime_bin_dir: &str,
    package_root: &str,
    npm_registry_exports: &str,
    ollama_models_dir: &str,
) -> String {
    format!(
        "export OPENCLAW_HOME={home}
export OPENCLAW_STATE_DIR={home}
export OPENCLAW_CONFIG_PATH={config}
export TMPDIR={tmp}
export NPM_CONFIG_CACHE={npm_cache}
export npm_config_cache={npm_cache}
export NPM_CONFIG_PREFIX={npm_prefix}
export npm_config_prefix={npm_prefix}
export COREPACK_HOME={corepack_home}
export OLLAMA_HOST={ollama_host}
export OLLAMA_MODELS={ollama_models}
export PATH={terminal_bin}:{runtime_bin}:$PATH
{npm_registry}cd {package_root}
echo {banner}
echo {hint}
echo
",
        home = shell_single_quote(openclaw_home),
        config = shell_single_quote(config_path),
        tmp = shell_single_quote(tmp_dir),
        npm_cache = shell_single_quote(npm_cache_dir),
        npm_prefix = shell_single_quote(npm_prefix_dir),
        corepack_home = shell_single_quote(corepack_home_dir),
        ollama_host = shell_single_quote(OLLAMA_HOST),
        ollama_models = shell_single_quote(ollama_models_dir),
        terminal_bin = shell_single_quote(terminal_bin_dir),
        runtime_bin = shell_single_quote(runtime_bin_dir),
        npm_registry = npm_registry_exports,
        package_root = shell_single_quote(package_root),
        banner = shell_single_quote("WhereClaw terminal is ready."),
        hint = shell_single_quote(whereclaw_terminal_hint_message()),
    )
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn build_whereclaw_terminal_windows_openclaw_wrapper_script(
    node_binary: &str,
    entry_script: &str,
) -> String {
    format!(
        "@echo off
\"{node}\" \"{entry}\" %*
",
        node = node_binary,
        entry = entry_script,
    )
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn build_whereclaw_terminal_windows_ollama_wrapper_script(
    ollama_binary: &str,
    ollama_models_dir: &str,
) -> String {
    format!(
        "@echo off
set OLLAMA_HOST={host}
set OLLAMA_MODELS={models}
\"{binary}\" %*
",
        host = OLLAMA_HOST,
        models = whereclaw_cmd_escape(ollama_models_dir),
        binary = ollama_binary,
    )
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn build_whereclaw_terminal_windows_script(
    openclaw_home: &str,
    config_path: &str,
    tmp_dir: &str,
    npm_cache_dir: &str,
    npm_prefix_dir: &str,
    corepack_home_dir: &str,
    terminal_bin_dir: &str,
    runtime_bin_dir: &str,
    package_root: &str,
    npm_registry_commands: &str,
    ollama_models_dir: &str,
) -> String {
    format!(
        "@echo off
set OPENCLAW_HOME={home}
set OPENCLAW_STATE_DIR={home}
set OPENCLAW_CONFIG_PATH={config}
set TMPDIR={tmp}
set NPM_CONFIG_CACHE={npm_cache}
set npm_config_cache={npm_cache}
set NPM_CONFIG_PREFIX={npm_prefix}
set npm_config_prefix={npm_prefix}
set COREPACK_HOME={corepack_home}
set OLLAMA_HOST={ollama_host}
set OLLAMA_MODELS={ollama_models}
set PATH={terminal_bin};{runtime_bin};%PATH%
{npm_registry}cd /d {package_root}
echo WhereClaw terminal is ready.
echo {hint}
echo.
%ComSpec% /K
",
        home = whereclaw_cmd_escape(openclaw_home),
        config = whereclaw_cmd_escape(config_path),
        tmp = whereclaw_cmd_escape(tmp_dir),
        npm_cache = whereclaw_cmd_escape(npm_cache_dir),
        npm_prefix = whereclaw_cmd_escape(npm_prefix_dir),
        corepack_home = whereclaw_cmd_escape(corepack_home_dir),
        ollama_host = OLLAMA_HOST,
        ollama_models = whereclaw_cmd_escape(ollama_models_dir),
        terminal_bin = whereclaw_cmd_escape(terminal_bin_dir),
        runtime_bin = whereclaw_cmd_escape(runtime_bin_dir),
        npm_registry = npm_registry_commands,
        package_root = whereclaw_cmd_escape(package_root),
        hint = whereclaw_terminal_hint_message(),
    )
}

#[tauri::command]
fn open_whereclaw_terminal(app: AppHandle) -> Result<(), String> {
    let launcher_preferences = read_launcher_preferences_impl(&app)?;
    if !launcher_preferences.has_saved_preferences {
        return Err(String::from(
            "Launcher preferences are not configured yet. Choose a language and install directory first.",
        ));
    }

    let engine_dir = resolve_engine_dir(&app)?;
    let node_binary = resolve_node_binary(&engine_dir)?;
    let runtime_bin_dir = resolve_runtime_bin_dir(&engine_dir)?;
    let ollama_binary = initialize_ollama_runtime(&app, &engine_dir)?;
    let ollama_models_dir = resolve_ollama_models_dir(&app)?;
    let entry_script = resolve_openclaw_entry(&engine_dir)?;
    let openclaw_package_root = resolve_openclaw_package_root(&entry_script)?;
    let openclaw_home = initialize_openclaw_home(&app, &engine_dir)?;
    let tmp_dir = initialize_openclaw_tmp_dir(&openclaw_home)?;
    let npm_cache_dir = resolve_npm_cache_dir(&openclaw_home);
    let npm_prefix_dir = resolve_npm_prefix_dir(&openclaw_home);
    let corepack_home_dir = resolve_corepack_home_dir(&openclaw_home);
    let terminal_bin_dir = openclaw_home.join("tmp").join("terminal-bin");

    let _ = append_launcher_log(
        &app,
        "INFO",
        &format!(
            "open_whereclaw_terminal openclaw_home={}",
            openclaw_home.display()
        ),
    );

    fs::create_dir_all(&terminal_bin_dir)
        .map_err(|error| format!("failed to create WhereClaw terminal bin directory: {error}"))?;

    #[cfg(target_os = "macos")]
    {
        let openclaw_wrapper_path = terminal_bin_dir.join("openclaw");
        let openclaw_wrapper = build_whereclaw_terminal_openclaw_wrapper_script(
            &node_binary.display().to_string(),
            &entry_script.display().to_string(),
        );
        fs::write(&openclaw_wrapper_path, openclaw_wrapper)
            .map_err(|error| format!("failed to write WhereClaw terminal wrapper: {error}"))?;
        Command::new("chmod")
            .arg("+x")
            .arg(&openclaw_wrapper_path)
            .status()
            .map_err(|error| {
                format!("failed to mark WhereClaw terminal wrapper executable: {error}")
            })?;

        let ollama_wrapper_path = terminal_bin_dir.join("ollama");
        let ollama_wrapper = build_whereclaw_terminal_ollama_wrapper_script(
            &ollama_binary.display().to_string(),
            &ollama_models_dir.display().to_string(),
        );
        fs::write(&ollama_wrapper_path, ollama_wrapper)
            .map_err(|error| format!("failed to write WhereClaw terminal ollama wrapper: {error}"))?;
        Command::new("chmod")
            .arg("+x")
            .arg(&ollama_wrapper_path)
            .status()
            .map_err(|error| {
                format!("failed to mark WhereClaw terminal ollama wrapper executable: {error}")
            })?;

        let shell_home_dir = openclaw_home.join("tmp").join("whereclaw-zdotdir");
        fs::create_dir_all(&shell_home_dir)
            .map_err(|error| format!("failed to create WhereClaw shell home directory: {error}"))?;
        let shell_rc_path = shell_home_dir.join(".zshrc");
        let npm_registry_exports = npm_registry_shell_exports(&launcher_preferences.language);
        let shell_rc = build_whereclaw_terminal_shell_rc(
            &openclaw_home.display().to_string(),
            &openclaw_home.join("openclaw.json").display().to_string(),
            &tmp_dir.display().to_string(),
            &npm_cache_dir.display().to_string(),
            &npm_prefix_dir.display().to_string(),
            &corepack_home_dir.display().to_string(),
            &terminal_bin_dir.display().to_string(),
            &runtime_bin_dir.display().to_string(),
            &openclaw_package_root.display().to_string(),
            &npm_registry_exports,
            &ollama_models_dir.display().to_string(),
        );
        fs::write(&shell_rc_path, shell_rc)
            .map_err(|error| format!("failed to write WhereClaw terminal environment: {error}"))?;

        let script_path = openclaw_home.join("tmp").join("whereclaw-terminal.command");
        let script = format!(
            "#!/bin/zsh\nexport ZDOTDIR={shell_home}\nexec /bin/zsh -i\n",
            shell_home = shell_single_quote(&shell_home_dir.display().to_string()),
        );
        fs::write(&script_path, script)
            .map_err(|error| format!("failed to write WhereClaw terminal script: {error}"))?;
        Command::new("chmod")
            .arg("+x")
            .arg(&script_path)
            .status()
            .map_err(|error| {
                format!("failed to mark WhereClaw terminal script executable: {error}")
            })?;
        Command::new("open")
            .arg("-a")
            .arg("Terminal")
            .arg(&script_path)
            .spawn()
            .map_err(|error| format!("failed to open WhereClaw terminal in Terminal: {error}"))?;
    }

    #[cfg(target_os = "windows")]
    {
        let openclaw_wrapper_path = terminal_bin_dir.join("openclaw.cmd");
        let openclaw_wrapper = build_whereclaw_terminal_windows_openclaw_wrapper_script(
            &node_binary.display().to_string(),
            &entry_script.display().to_string(),
        );
        fs::write(&openclaw_wrapper_path, openclaw_wrapper)
            .map_err(|error| format!("failed to write WhereClaw terminal wrapper: {error}"))?;

        let ollama_wrapper_path = terminal_bin_dir.join("ollama.cmd");
        let ollama_wrapper = build_whereclaw_terminal_windows_ollama_wrapper_script(
            &ollama_binary.display().to_string(),
            &ollama_models_dir.display().to_string(),
        );
        fs::write(&ollama_wrapper_path, ollama_wrapper)
            .map_err(|error| format!("failed to write WhereClaw terminal ollama wrapper: {error}"))?;

        let script_path = openclaw_home.join("tmp").join("whereclaw-terminal.cmd");
        let npm_registry_commands = npm_registry_cmd_exports(&launcher_preferences.language);
        let script = build_whereclaw_terminal_windows_script(
            &openclaw_home.display().to_string(),
            &openclaw_home.join("openclaw.json").display().to_string(),
            &tmp_dir.display().to_string(),
            &npm_cache_dir.display().to_string(),
            &npm_prefix_dir.display().to_string(),
            &corepack_home_dir.display().to_string(),
            &terminal_bin_dir.display().to_string(),
            &runtime_bin_dir.display().to_string(),
            &openclaw_package_root.display().to_string(),
            &npm_registry_commands,
            &ollama_models_dir.display().to_string(),
        );
        fs::write(&script_path, script)
            .map_err(|error| format!("failed to write WhereClaw terminal script: {error}"))?;
        Command::new("cmd")
            .args([
                "/C",
                "start",
                "WhereClaw Terminal",
                script_path.to_string_lossy().as_ref(),
            ])
            .spawn()
            .map_err(|error| {
                format!("failed to open WhereClaw terminal in Command Prompt: {error}")
            })?;
    }

    Ok(())
}

#[tauri::command]
fn open_official_setup_wizard(app: AppHandle) -> Result<(), String> {
    let _ = append_launcher_log(&app, "INFO", "open_official_setup_wizard requested");
    open_official_terminal_command(
        app,
        "OpenClaw Setup",
        "WhereClaw is opening the official OpenClaw setup wizard.",
        &["onboard"],
        "OpenClaw setup finished. You can close this Terminal window.",
        "setup",
    )
}

#[tauri::command]
fn open_channel_add_wizard(app: AppHandle) -> Result<(), String> {
    open_official_terminal_command(
        app,
        "OpenClaw Channels Add",
        "WhereClaw is opening the official OpenClaw channel add/update flow.",
        &["channels", "add"],
        "OpenClaw channel add/update finished. You can close this Terminal window.",
        "channels-add",
    )
}

#[tauri::command]
fn open_model_provider_add_wizard(app: AppHandle) -> Result<(), String> {
    open_official_terminal_command(
        app,
        "OpenClaw Configure Model",
        "WhereClaw is opening the official OpenClaw model configuration flow.",
        &["configure", "--section", "model"],
        "OpenClaw model configuration finished. You can close this Terminal window.",
        "models-configure-model",
    )
}

#[tauri::command]
fn open_model_add_wizard(app: AppHandle) -> Result<(), String> {
    open_official_terminal_command(
        app,
        "OpenClaw Configure Model",
        "WhereClaw is opening the official OpenClaw model configuration flow.",
        &["configure", "--section", "model"],
        "OpenClaw model configuration finished. You can close this Terminal window.",
        "models-configure-model",
    )
}

fn open_official_terminal_command(
    app: AppHandle,
    _command_window_title: &str,
    intro_message: &str,
    openclaw_args: &[&str],
    finish_message: &str,
    script_stem: &str,
) -> Result<(), String> {
    let launcher_preferences = read_launcher_preferences_impl(&app)?;
    if !launcher_preferences.has_saved_preferences {
        return Err(String::from(
            "Launcher preferences are not configured yet. Choose a language and install directory first.",
        ));
    }

    let engine_dir = resolve_engine_dir(&app)?;
    let node_binary = resolve_node_binary(&engine_dir)?;
    let runtime_bin_dir = resolve_runtime_bin_dir(&engine_dir)?;
    let entry_script = resolve_openclaw_entry(&engine_dir)?;
    let openclaw_package_root = resolve_openclaw_package_root(&entry_script)?;
    let openclaw_home = initialize_openclaw_home(&app, &engine_dir)?;
    let tmp_dir = initialize_openclaw_tmp_dir(&openclaw_home)?;
    let npm_cache_dir = resolve_npm_cache_dir(&openclaw_home);
    let npm_prefix_dir = resolve_npm_prefix_dir(&openclaw_home);
    let corepack_home_dir = resolve_corepack_home_dir(&openclaw_home);

    #[cfg(target_os = "macos")]
    {
        let npm_registry_exports = npm_registry_shell_exports(&launcher_preferences.language);
        let openclaw_argv = openclaw_args
            .iter()
            .map(|value| shell_single_quote(value))
            .collect::<Vec<_>>()
            .join(" ");
        let script_path = openclaw_home
            .join("tmp")
            .join(format!("whereclaw-{script_stem}.command"));
        let script = format!(
            "#!/bin/zsh\nexport OPENCLAW_HOME={home}\nexport OPENCLAW_STATE_DIR={home}\nexport OPENCLAW_CONFIG_PATH={config}\nexport TMPDIR={tmp}\nexport NPM_CONFIG_CACHE={npm_cache}\nexport npm_config_cache={npm_cache}\nexport NPM_CONFIG_PREFIX={npm_prefix}\nexport npm_config_prefix={npm_prefix}\nexport COREPACK_HOME={corepack_home}\nexport PATH={runtime_bin}:$PATH\ncd {package_root}\n{npm_registry}clear\necho {intro}\necho\n\"{node}\" \"{entry}\" {argv}\necho\necho {finish}\nread -k 1 '?Press any key to close...'\n",
            home = shell_single_quote(&openclaw_home.display().to_string()),
            config = shell_single_quote(&openclaw_home.join("openclaw.json").display().to_string()),
            tmp = shell_single_quote(&tmp_dir.display().to_string()),
            npm_cache = shell_single_quote(&npm_cache_dir.display().to_string()),
            npm_prefix = shell_single_quote(&npm_prefix_dir.display().to_string()),
            corepack_home = shell_single_quote(&corepack_home_dir.display().to_string()),
            runtime_bin = shell_single_quote(&runtime_bin_dir.display().to_string()),
            package_root = shell_single_quote(&openclaw_package_root.display().to_string()),
            npm_registry = npm_registry_exports,
            intro = shell_single_quote(intro_message),
            finish = shell_single_quote(finish_message),
            node = node_binary.display(),
            entry = entry_script.display(),
            argv = openclaw_argv,
        );
        fs::write(&script_path, script)
            .map_err(|error| format!("failed to write official setup script: {error}"))?;
        Command::new("chmod")
            .arg("+x")
            .arg(&script_path)
            .status()
            .map_err(|error| format!("failed to mark official setup script executable: {error}"))?;
        Command::new("open")
            .arg("-a")
            .arg("Terminal")
            .arg(&script_path)
            .spawn()
            .map_err(|error| {
                format!("failed to open official OpenClaw command in Terminal: {error}")
            })?;
    }

    #[cfg(target_os = "windows")]
    {
        let npm_registry_commands = npm_registry_cmd_exports(&launcher_preferences.language);
        let openclaw_cmd_argv = openclaw_args.join(" ");
        let script_path = openclaw_home
            .join("tmp")
            .join(format!("whereclaw-{script_stem}.cmd"));
        let script = format!(
            "@echo off\r\nset OPENCLAW_HOME={home}\r\nset OPENCLAW_STATE_DIR={home}\r\nset OPENCLAW_CONFIG_PATH={config}\r\nset TMPDIR={tmp}\r\nset NPM_CONFIG_CACHE={npm_cache}\r\nset npm_config_cache={npm_cache}\r\nset NPM_CONFIG_PREFIX={npm_prefix}\r\nset npm_config_prefix={npm_prefix}\r\nset COREPACK_HOME={corepack_home}\r\nset PATH={runtime_bin};%PATH%\r\ncd /d {package_root}\r\n{npm_registry}cls\r\necho {intro}\r\necho.\r\n\"{node}\" \"{entry}\" {argv}\r\necho.\r\necho {finish}\r\npause\r\n",
            home = cmd_escape(&openclaw_home.display().to_string()),
            config = cmd_escape(&openclaw_home.join("openclaw.json").display().to_string()),
            tmp = cmd_escape(&tmp_dir.display().to_string()),
            npm_cache = cmd_escape(&npm_cache_dir.display().to_string()),
            npm_prefix = cmd_escape(&npm_prefix_dir.display().to_string()),
            corepack_home = cmd_escape(&corepack_home_dir.display().to_string()),
            runtime_bin = cmd_escape(&runtime_bin_dir.display().to_string()),
            package_root = cmd_escape(&openclaw_package_root.display().to_string()),
            npm_registry = npm_registry_commands,
            intro = intro_message,
            finish = finish_message,
            node = node_binary.display(),
            entry = entry_script.display(),
            argv = openclaw_cmd_argv,
        );
        fs::write(&script_path, script)
            .map_err(|error| format!("failed to write official setup script: {error}"))?;
        Command::new("cmd")
            .args([
                "/C",
                "start",
                _command_window_title,
                script_path.to_string_lossy().as_ref(),
            ])
            .spawn()
            .map_err(|error| {
                format!("failed to open official OpenClaw command in terminal: {error}")
            })?;
    }

    Ok(())
}

fn open_path_in_default_app(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(path)
            .status()
            .map_err(|error| format!("failed to open path in Finder: {error}"))
            .and_then(|status| {
                if status.success() {
                    Ok(())
                } else {
                    Err(format!(
                        "opening path in Finder exited with status {status}"
                    ))
                }
            })?;
    }

    #[cfg(target_os = "windows")]
    {
        Command::new("cmd")
            .args(["/C", "start", ""])
            .arg(path)
            .status()
            .map_err(|error| format!("failed to open path in Explorer: {error}"))
            .and_then(|status| {
                if status.success() {
                    Ok(())
                } else {
                    Err(format!(
                        "opening path in Explorer exited with status {status}"
                    ))
                }
            })?;
    }

    Ok(())
}

fn control_ui_window_initialization_script(language: &str) -> Result<String, String> {
    let locale_json = serde_json::to_string(language)
        .map_err(|error| format!("failed to serialize launcher language: {error}"))?;

    Ok(format!(
        r#"
const __WHERECLAW_LOCALE__ = {locale_json};

(() => {{
  const OPEN_BUTTON_ID = 'whereclaw-open-browser-button';
  const OPEN_BUTTON_STYLE_ID = 'whereclaw-open-browser-style';
  const labels = __WHERECLAW_LOCALE__ === 'zh-CN'
    ? {{
        open: '使用默认浏览器打开',
        opening: '正在打开...',
      }}
    : {{
        open: 'Open in Default Browser',
        opening: 'Opening...',
      }};

  const ensureLocale = () => {{
    try {{
      window.localStorage.setItem('openclaw.i18n.locale', __WHERECLAW_LOCALE__);
    }} catch (_error) {{
      // Ignore localStorage failures in injected setup.
    }}
  }};

  const ensureStyle = () => {{
    if (document.getElementById(OPEN_BUTTON_STYLE_ID)) return;

    const style = document.createElement('style');
    style.id = OPEN_BUTTON_STYLE_ID;
    style.textContent = `
      #${{OPEN_BUTTON_ID}} {{
        position: fixed;
        top: 46px;
        right: 12px;
        z-index: 2147483647;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        padding: 0;
        border: 1px solid rgba(15, 23, 42, 0.08);
        border-radius: 999px;
        background: rgba(15, 23, 42, 0.5);
        color: #fff;
        font: 700 13px/1 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        box-shadow: 0 8px 20px rgba(15, 23, 42, 0.16);
        cursor: pointer;
        backdrop-filter: blur(12px);
        opacity: 0.68;
      }}
      #${{OPEN_BUTTON_ID}}:hover {{
        background: rgba(30, 41, 59, 0.72);
        opacity: 0.9;
      }}
    `;

    document.documentElement.appendChild(style);
  }};

  const openInBrowser = async (button) => {{
    const invoke = window.__TAURI_INTERNALS__?.invoke;
    if (typeof invoke !== 'function') return;

    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = '...';

    try {{
      await invoke('open_control_ui_in_browser', {{}});
      button.textContent = originalText;
    }} finally {{
      button.disabled = false;
    }}
  }};

  const ensureButton = () => {{
    ensureLocale();
    ensureStyle();

    if (document.getElementById(OPEN_BUTTON_ID)) return;

    const button = document.createElement('button');
    button.id = OPEN_BUTTON_ID;
    button.type = 'button';
    button.textContent = '↗';
    button.setAttribute('aria-label', labels.open);
    button.setAttribute('title', labels.open);
    button.addEventListener('click', () => {{
      void openInBrowser(button);
    }});

    document.body.appendChild(button);
  }};

  const scheduleEnsure = () => {{
    ensureButton();
    window.setTimeout(ensureButton, 300);
    window.setTimeout(ensureButton, 1200);
  }};

  if (document.readyState === 'loading') {{
    document.addEventListener('DOMContentLoaded', scheduleEnsure, {{ once: true }});
  }} else {{
    scheduleEnsure();
  }}

  const observer = new MutationObserver(() => {{
    ensureButton();
  }});

  observer.observe(document.documentElement, {{ childList: true, subtree: true }});
}})();
"#
    ))
}

#[tauri::command]
async fn read_setup_info(app: AppHandle) -> Result<SetupInfo, String> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || read_setup_info_impl(&app))
        .await
        .map_err(|error| format!("failed to join setup-info task: {error}"))?
}

#[tauri::command]
async fn read_launcher_preferences(app: AppHandle) -> Result<LauncherPreferences, String> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || read_launcher_preferences_impl(&app))
        .await
        .map_err(|error| format!("failed to join preferences read task: {error}"))?
}

#[tauri::command]
async fn ensure_remote_skill_catalog_fresh(
    app: AppHandle,
) -> Result<SkillCatalogRefreshResult, String> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || ensure_remote_skill_catalog_fresh_impl(&app))
        .await
        .map_err(|error| format!("failed to join remote skill catalog refresh task: {error}"))?
}

#[tauri::command]
async fn read_active_skill_catalog(app: AppHandle) -> Result<ActiveSkillCatalogPayload, String> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || read_active_skill_catalog_impl(&app))
        .await
        .map_err(|error| format!("failed to join active skill catalog read task: {error}"))?
}

#[tauri::command]
async fn read_remote_notifications(app: AppHandle) -> Result<RemoteNotificationsPayload, String> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || read_remote_notifications_impl(&app))
        .await
        .map_err(|error| format!("failed to join remote notifications read task: {error}"))?
}

#[tauri::command]
async fn read_remote_desktop_version(
    app: AppHandle,
) -> Result<RemoteDesktopVersionPayload, String> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || read_remote_desktop_version_impl(&app))
        .await
        .map_err(|error| format!("failed to join remote desktop version read task: {error}"))?
}

#[tauri::command]
async fn save_launcher_preferences(
    app: AppHandle,
    language: String,
    install_dir: String,
    is_initialized: Option<bool>,
    is_initialization_in_progress: Option<bool>,
) -> Result<LauncherPreferences, String> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        save_launcher_preferences_impl(
            &app,
            &language,
            &install_dir,
            is_initialized,
            is_initialization_in_progress,
        )
    })
    .await
    .map_err(|error| format!("failed to join preferences save task: {error}"))?
}

#[tauri::command]
async fn get_system_memory_info() -> Result<SystemMemoryInfo, String> {
    let info = tauri::async_runtime::spawn_blocking(|| collect_system_memory_info())
        .await
        .map_err(|error| format!("failed to join memory-info task: {error}"))??;
    Ok(info)
}

#[tauri::command]
async fn reset_launcher_state(
    app: AppHandle,
    state: tauri::State<'_, GatewayState>,
    ollama_state: tauri::State<'_, OllamaState>,
) -> Result<LauncherPreferences, String> {
    let app = app.clone();
    let child = state.child.clone();
    let ollama_child = ollama_state.child.clone();
    let current_port = state.current_port.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut child_slot = child
            .lock()
            .map_err(|_| String::from("failed to acquire gateway state lock"))?;

        if let Some(mut process) = child_slot.take() {
            let _ = process.child.kill();
            let _ = process.child.wait();
        }

        if let Some(window) = app.get_webview_window(CONTROL_UI_WINDOW_LABEL) {
            let _ = window.close();
        }

        let mut ollama_slot = ollama_child
            .lock()
            .map_err(|_| String::from("failed to acquire ollama state lock"))?;

        if let Some(mut process) = ollama_slot.take() {
            let _ = process.kill();
            let _ = process.wait();
        }

        let settings_path = resolve_launcher_settings_path(&app)?;
        let install_dir = if settings_path.exists() {
            Some(normalize_install_dir(
                &read_launcher_preferences_impl(&app)?.install_dir,
            )?)
        } else {
            None
        };

        if let Some(install_dir) = install_dir.filter(|path| path.exists()) {
            fs::remove_dir_all(&install_dir).map_err(|error| {
                format!(
                    "failed to remove launcher install directory {}: {error}",
                    install_dir.display()
                )
            })?;
        }

        if settings_path.exists() {
            fs::remove_file(&settings_path)
                .map_err(|error| format!("failed to remove launcher settings: {error}"))?;
        }

        for path in [
            resolve_ollama_runtime_dir(&app)?,
            resolve_launcher_data_dir(&app)?.join("ollama-models"),
        ] {
            if path.exists() {
                fs::remove_dir_all(&path).map_err(|error| {
                    format!(
                        "failed to remove launcher data directory {}: {error}",
                        path.display()
                    )
                })?;
            }
        }

        *current_port
            .lock()
            .map_err(|_| String::from("failed to acquire gateway port state lock"))? =
            CONTROL_UI_PORT;

        read_launcher_preferences_impl(&app)
    })
    .await
    .map_err(|error| format!("failed to join launcher reset task: {error}"))?
}

#[tauri::command]
async fn reset_openclaw_config(
    app: AppHandle,
    state: tauri::State<'_, GatewayState>,
) -> Result<SetupInfo, String> {
    let app = app.clone();
    let child = state.child.clone();
    let current_port = state.current_port.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut child_slot = child
            .lock()
            .map_err(|_| String::from("failed to acquire gateway state lock"))?;

        if let Some(mut process) = child_slot.take() {
            let _ = process.child.kill();
            let _ = process.child.wait();
        }

        if let Some(window) = app.get_webview_window(CONTROL_UI_WINDOW_LABEL) {
            let _ = window.close();
        }

        let preferences = read_launcher_preferences_impl(&app)?;
        if !preferences.has_saved_preferences {
            return Err(String::from(
                "Launcher preferences are not configured yet. Choose a language and install directory first.",
            ));
        }

        let openclaw_home = normalize_install_dir(&preferences.install_dir)?;
        if openclaw_home.exists() {
            fs::remove_dir_all(&openclaw_home).map_err(|error| {
                format!(
                    "failed to remove OpenClaw home directory {}: {error}",
                    openclaw_home.display()
                )
            })?;
        }

        let launcher_logs_dir = resolve_launcher_logs_dir(&app)?;
        if launcher_logs_dir.exists() {
            fs::remove_dir_all(&launcher_logs_dir).map_err(|error| {
                format!(
                    "failed to remove launcher logs directory {}: {error}",
                    launcher_logs_dir.display()
                )
            })?;
        }

        let engine_dir = resolve_engine_dir(&app)?;
        initialize_openclaw_home(&app, &engine_dir)?;

        *current_port
            .lock()
            .map_err(|_| String::from("failed to acquire gateway port state lock"))? =
            CONTROL_UI_PORT;

        read_setup_info_impl(&app)
    })
    .await
    .map_err(|error| format!("failed to join OpenClaw reset task: {error}"))?
}

#[tauri::command]
async fn apply_initial_setup_config(
    app: AppHandle,
    request: InitialSetupConfigRequest,
) -> Result<SetupInfo, String> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let preferences = read_launcher_preferences_impl(&app)?;
        if !preferences.has_saved_preferences {
            return Err(String::from(
                "Launcher preferences are not configured yet. Choose a language and install directory first.",
            ));
        }

        let engine_dir = resolve_engine_dir(&app)?;
        let openclaw_home = initialize_openclaw_home(&app, &engine_dir)?;
        let mut config = read_openclaw_config(&openclaw_home)?;
        let root = ensure_object(&mut config, "OpenClaw config root")?;

        if let Some(model) = request.local_model {
            let normalized_model = normalize_and_validate_ollama_model_name(&model)?;
            if !normalized_model.is_empty() {
                apply_initial_ollama_model_config(root, normalized_model);
            }
        }

        if let Some(qq) = request.qq {
            let app_id = qq.app_id.trim();
            let app_secret = qq.app_secret.trim();
            if !app_id.is_empty() && !app_secret.is_empty() {
                let qq_plugin_path = ensure_qq_plugin_ready(&app, &engine_dir)?;
                apply_initial_qq_channel_config(root, app_id, app_secret, qq_plugin_path.as_deref())?;
            }
        }

        write_openclaw_config(&openclaw_home, &config)?;
        sanitize_openclaw_config(&openclaw_home)?;
        save_launcher_preferences_impl(
            &app,
            &preferences.language,
            &preferences.install_dir,
            Some(true),
            Some(false),
        )?;
        read_setup_info_impl(&app)
    })
    .await
    .map_err(|error| format!("failed to join initial setup task: {error}"))?
}

#[tauri::command]
async fn list_channel_accounts(app: AppHandle) -> Result<Vec<ChannelAccount>, String> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || list_channel_accounts_impl(&app))
        .await
        .map_err(|error| format!("failed to join channel-list task: {error}"))?
}

#[tauri::command]
async fn remove_channel_account(
    app: AppHandle,
    channel: String,
    account_id: String,
) -> Result<(), String> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        remove_channel_account_impl(&app, &channel, &account_id)
    })
    .await
    .map_err(|error| format!("failed to join channel-remove task: {error}"))?
}

#[tauri::command]
async fn list_openclaw_models(app: AppHandle) -> Result<Vec<ModelCatalogEntry>, String> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || list_openclaw_models_impl(&app))
        .await
        .map_err(|error| format!("failed to join models-list task: {error}"))?
}

#[tauri::command]
async fn list_installed_skills(app: AppHandle) -> Result<Vec<InstalledSkillEntry>, String> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || list_installed_skills_impl(&app))
        .await
        .map_err(|error| format!("failed to join installed-skills task: {error}"))?
}

#[tauri::command]
async fn set_skill_enabled(app: AppHandle, skill_key: String, enabled: bool) -> Result<(), String> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || set_skill_enabled_impl(&app, &skill_key, enabled))
        .await
        .map_err(|error| format!("failed to join set-skill-enabled task: {error}"))?
}

#[tauri::command]
async fn install_skill_from_catalog(app: AppHandle, slug: String) -> Result<(), String> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || install_skill_from_catalog_impl(&app, &slug))
        .await
        .map_err(|error| format!("failed to join install-skill task: {error}"))?
}

#[tauri::command]
async fn remove_workspace_skill(app: AppHandle, slug: String) -> Result<(), String> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || remove_workspace_skill_impl(&app, &slug))
        .await
        .map_err(|error| format!("failed to join remove-workspace-skill task: {error}"))?
}

#[tauri::command]
async fn read_launcher_logs(app: AppHandle, source: Option<String>) -> Result<String, String> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || read_launcher_logs_impl(&app, source.as_deref()))
        .await
        .map_err(|error| format!("failed to join launcher-log-read task: {error}"))?
}

#[tauri::command]
async fn append_frontend_log(
    app: AppHandle,
    level: String,
    message: String,
    context: Option<Value>,
) -> Result<(), String> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        append_frontend_log_impl(&app, &level, &message, context.as_ref())
    })
    .await
    .map_err(|error| format!("failed to join frontend-log task: {error}"))?
}

#[tauri::command]
async fn set_openclaw_primary_model(app: AppHandle, model: String) -> Result<(), String> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || set_openclaw_primary_model_impl(&app, &model))
        .await
        .map_err(|error| format!("failed to join model-set task: {error}"))?
}

#[tauri::command]
async fn save_local_model_selection(app: AppHandle, model: String) -> Result<(), String> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || save_local_model_selection_impl(&app, &model))
        .await
        .map_err(|error| format!("failed to join local-model-save task: {error}"))?
}

fn start_gateway_impl(
    app: &AppHandle,
    child_state: &Arc<Mutex<Option<GatewayProcess>>>,
    current_port: &Arc<Mutex<u16>>,
) -> Result<GatewayStatus, String> {
    let _ = append_launcher_log(app, "INFO", "start_gateway requested");
    let launcher_preferences = read_launcher_preferences_impl(app)?;
    if !launcher_preferences.has_saved_preferences {
        return Err(String::from(
            "Launcher preferences are not configured yet. Choose a language and install directory first.",
        ));
    }

    let mut child_slot = child_state
        .lock()
        .map_err(|_| String::from("failed to acquire gateway state lock"))?;

    if let Some(process) = child_slot.as_mut() {
        if process
            .child
            .try_wait()
            .map_err(|error| format!("failed to inspect gateway process state: {error}"))?
            .is_none()
        {
            let port = *current_port
                .lock()
                .map_err(|_| String::from("failed to acquire gateway port state lock"))?;
            return Ok(GatewayStatus {
                running: true,
                pid: process.child.process_id(),
                url: control_ui_url_for_port(port),
            });
        }

        *child_slot = None;
    }

    let engine_dir = resolve_engine_dir(app)?;
    let node_binary = resolve_node_binary(&engine_dir)?;
    let runtime_bin_dir = resolve_runtime_bin_dir(&engine_dir)?;
    let entry_script = resolve_openclaw_entry(&engine_dir)?;
    let openclaw_package_root = resolve_openclaw_package_root(&entry_script)?;
    stop_conflicting_gateway_services();
    let openclaw_home = initialize_openclaw_home(app, &engine_dir)?;
    let config = read_openclaw_config(&openclaw_home)?;
    if !is_configured(&config) {
        return Err(String::from(
            "No model is configured yet. Configure a model first, then start the gateway.",
        ));
    }
    let configured_port =
        number_at_path(&config, &["gateway", "port"]).unwrap_or(CONTROL_UI_PORT.into()) as u16;
    ensure_local_gateway_mode(&openclaw_home)?;
    let tmp_dir = initialize_openclaw_tmp_dir(&openclaw_home)?;
    let npm_cache_dir = resolve_npm_cache_dir(&openclaw_home);
    let npm_prefix_dir = resolve_npm_prefix_dir(&openclaw_home);
    let corepack_home_dir = resolve_corepack_home_dir(&openclaw_home);
    let logs_dir = openclaw_home.join("logs");
    let console_log = logs_dir.join("gateway.console.log");
    let console_handle = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&console_log)
        .map_err(|error| format!("failed to create gateway console log: {error}"))?;
    let pty_system = native_pty_system();
    let pty_pair = pty_system
        .openpty(PtySize {
            rows: 40,
            cols: 160,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("failed to create gateway PTY: {error}"))?;
    let mut reader = pty_pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("failed to clone gateway PTY reader: {error}"))?;
    thread::spawn(move || {
        let mut log_file = console_handle;
        let mut buffer = [0_u8; 4096];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(size) => {
                    if log_file.write_all(&buffer[..size]).is_err() {
                        break;
                    }
                    let _ = log_file.flush();
                }
                Err(_) => break,
            }
        }
    });

    let mut command = CommandBuilder::new(node_binary);
    command.cwd(&openclaw_package_root);
    command.arg(entry_script);
    command.arg("gateway");
    command.arg("--port");
    command.arg(configured_port.to_string());
    command.env("OPENCLAW_HOME", &openclaw_home);
    command.env("OPENCLAW_STATE_DIR", &openclaw_home);
    command.env("OPENCLAW_CONFIG_PATH", openclaw_home.join("openclaw.json"));
    command.env("TMPDIR", &tmp_dir);
    command.env("NPM_CONFIG_CACHE", &npm_cache_dir);
    command.env("npm_config_cache", &npm_cache_dir);
    command.env("NPM_CONFIG_PREFIX", &npm_prefix_dir);
    command.env("npm_config_prefix", &npm_prefix_dir);
    command.env("COREPACK_HOME", &corepack_home_dir);
    apply_registry_env_to_pty_command(&mut command, &launcher_preferences.language);
    prepend_path_env_to_pty_command(&mut command, &runtime_bin_dir)?;

    let child = pty_pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("failed to start bundled OpenClaw gateway: {error}"))?;

    let pid = child.process_id();
    *child_slot = Some(GatewayProcess {
        child,
        _master: pty_pair.master,
    });
    *current_port
        .lock()
        .map_err(|_| String::from("failed to acquire gateway port state lock"))? = configured_port;

    if let Err(error) = wait_for_gateway_ready(&mut child_slot, &console_log, configured_port) {
        let _ = append_launcher_log(
            app,
            "ERROR",
            &format!("start_gateway failed port={configured_port} error={error}"),
        );
        if let Some(mut running_process) = child_slot.take() {
            let _ = running_process.child.kill();
            let _ = running_process.child.wait();
        }
        return Err(error);
    }

    let _ = append_launcher_log(
        app,
        "INFO",
        &format!("start_gateway succeeded pid={pid:?} port={configured_port}"),
    );
    Ok(GatewayStatus {
        running: true,
        pid,
        url: resolve_control_ui_url(app)?,
    })
}

#[cfg(target_os = "macos")]
fn stop_conflicting_gateway_services() {
    let Some(home_dir) = env::var_os("HOME") else {
        return;
    };

    let launch_agents_dir = PathBuf::from(home_dir).join("Library").join("LaunchAgents");
    let conflict_plists = [
        launch_agents_dir.join("com.clawdbot.gateway.plist"),
        launch_agents_dir.join("ai.openclaw.gateway.plist"),
    ];

    for plist_path in conflict_plists {
        if !plist_path.exists() {
            continue;
        }

        let _ = Command::new("launchctl")
            .arg("unload")
            .arg("-w")
            .arg(&plist_path)
            .status();
    }
}

#[cfg(not(target_os = "macos"))]
fn stop_conflicting_gateway_services() {}

fn wait_for_gateway_ready(
    child_slot: &mut Option<GatewayProcess>,
    console_log: &Path,
    port: u16,
) -> Result<(), String> {
    let address = format!("127.0.0.1:{port}");

    for _ in 0..HEALTH_CHECK_ATTEMPTS {
        if let Some(process) = child_slot.as_mut() {
            if let Some(status) = process
                .child
                .try_wait()
                .map_err(|error| format!("failed to inspect gateway process state: {error}"))?
            {
                let console_excerpt = fs::read_to_string(console_log).ok().map(|content| {
                    let mut lines = content
                        .lines()
                        .rev()
                        .take(8)
                        .map(str::to_owned)
                        .collect::<Vec<_>>();
                    lines.reverse();
                    lines.join("\n")
                });

                let mut message = format!("OpenClaw gateway exited early with status {status}.");
                if let Some(console_excerpt) =
                    console_excerpt.filter(|value| !value.trim().is_empty())
                {
                    message.push_str("\n\n");
                    message.push_str(&console_excerpt);
                }
                return Err(message);
            }
        }

        if std::net::TcpStream::connect(&address).is_ok() {
            return Ok(());
        }

        thread::sleep(Duration::from_millis(HEALTH_CHECK_DELAY_MS));
    }

    Err(format!(
        "OpenClaw gateway did not become ready at {} in time.",
        control_ui_url_for_port(port)
    ))
}

fn control_ui_url_for_port(port: u16) -> String {
    format!("http://127.0.0.1:{port}/")
}

fn resolve_control_ui_url(app: &AppHandle) -> Result<String, String> {
    let openclaw_home = resolve_openclaw_home_dir(app)?;
    let config = read_openclaw_config(&openclaw_home)?;
    let port =
        number_at_path(&config, &["gateway", "port"]).unwrap_or(CONTROL_UI_PORT.into()) as u16;
    let mut url = Url::parse(&control_ui_url_for_port(port))
        .map_err(|error| format!("failed to construct Control UI URL: {error}"))?;

    if let Some((key, value)) = resolve_control_ui_bootstrap_auth(&config) {
        url.query_pairs_mut().append_pair(key, &value);
    }

    Ok(url.to_string())
}

fn resolve_control_ui_bootstrap_auth(config: &Value) -> Option<(&'static str, String)> {
    let auth_mode = string_at_path(config, &["gateway", "auth", "mode"]);
    let token = string_at_path(config, &["gateway", "auth", "token"])
        .filter(|value| !value.trim().is_empty());
    let password = string_at_path(config, &["gateway", "auth", "password"])
        .filter(|value| !value.trim().is_empty());

    match auth_mode.as_deref() {
        Some("none") => None,
        Some("token") => token.map(|value| ("token", value)),
        Some("password") => password.map(|value| ("password", value)),
        _ => {
            if token.is_some() && password.is_none() {
                token.map(|value| ("token", value))
            } else if password.is_some() && token.is_none() {
                password.map(|value| ("password", value))
            } else {
                None
            }
        }
    }
}

fn start_ollama_impl(
    app: &AppHandle,
    child_state: &Arc<Mutex<Option<StdChild>>>,
) -> Result<OllamaStatus, String> {
    let mut child_slot = child_state
        .lock()
        .map_err(|_| String::from("failed to acquire ollama state lock"))?;

    if let Some(process) = child_slot.as_mut() {
        if process
            .try_wait()
            .map_err(|error| format!("failed to inspect ollama process state: {error}"))?
            .is_none()
        {
            return build_ollama_status(app, Some(process.id()), true);
        }

        *child_slot = None;
    }

    if is_ollama_reachable() {
        return build_ollama_status(app, None, true);
    }

    let engine_dir = resolve_engine_dir(app)?;
    let ollama_binary = initialize_ollama_runtime(app, &engine_dir)?;
    let ollama_runtime_dir = ollama_binary
        .parent()
        .ok_or_else(|| String::from("bundled ollama binary has no parent directory"))?
        .to_path_buf();
    let models_dir = resolve_ollama_models_dir(app)?;
    let logs_dir = resolve_launcher_logs_dir(app)?;
    fs::create_dir_all(&logs_dir)
        .map_err(|error| format!("failed to create launcher logs directory: {error}"))?;
    let ollama_log = logs_dir.join("ollama.log");
    let stdout_log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&ollama_log)
        .map_err(|error| format!("failed to open ollama log file: {error}"))?;
    let stderr_log = stdout_log
        .try_clone()
        .map_err(|error| format!("failed to clone ollama log file handle: {error}"))?;

    let child = Command::new(&ollama_binary)
        .current_dir(&ollama_runtime_dir)
        .arg("serve")
        .env("OLLAMA_HOST", OLLAMA_HOST)
        .env("OLLAMA_MODELS", &models_dir)
        .stdout(Stdio::from(stdout_log))
        .stderr(Stdio::from(stderr_log))
        .spawn()
        .map_err(|error| format!("failed to start bundled ollama: {error}"))?;

    let pid = child.id();
    *child_slot = Some(child);

    if let Err(error) = wait_for_ollama_ready(&mut child_slot) {
        if let Some(mut running_process) = child_slot.take() {
            let _ = running_process.kill();
            let _ = running_process.wait();
        }
        return Err(error);
    }

    build_ollama_status(app, Some(pid), true)
}

fn is_ollama_reachable() -> bool {
    std::net::TcpStream::connect(format!("127.0.0.1:{OLLAMA_PORT}")).is_ok()
}

fn stop_all_ollama_processes() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        if let Ok(uid) = env::var("UID") {
            let _ = Command::new("launchctl")
                .args(["bootout", &format!("gui/{uid}/com.ollama.ollama")])
                .status();
        }
        if let Ok(home) = env::var("HOME") {
            let _ = Command::new("launchctl")
                .args([
                    "bootout",
                    "gui",
                    &format!("{home}/Library/LaunchAgents/com.ollama.ollama.plist"),
                ])
                .status();
        }

        let status = Command::new("pkill")
            .args(["-x", "ollama"])
            .status()
            .map_err(|error| format!("failed to execute pkill for ollama: {error}"))?;

        // pkill exits with 1 when no matching process exists.
        if status.code().is_some_and(|code| code > 1) {
            return Err(format!("pkill returned unexpected status: {status}"));
        }

        let status = Command::new("pkill")
            .args(["-f", "ollama serve"])
            .status()
            .map_err(|error| format!("failed to execute pkill -f for ollama serve: {error}"))?;
        if status.code().is_some_and(|code| code > 1) {
            return Err(format!("pkill -f returned unexpected status: {status}"));
        }

        kill_ollama_port_processes_macos()?;
    }

    #[cfg(target_os = "windows")]
    {
        let status = Command::new("taskkill")
            .args(["/IM", "ollama.exe", "/F", "/T"])
            .status()
            .map_err(|error| format!("failed to execute taskkill for ollama.exe: {error}"))?;

        // taskkill may return non-zero when process is not found; tolerate that case.
        if !status.success() {
            let _ = Command::new("tasklist")
                .args(["/FI", "IMAGENAME eq ollama.exe"])
                .status();
        }

        kill_ollama_port_processes_windows()?;
    }

    Ok(())
}

#[cfg(target_os = "macos")]
fn kill_ollama_port_processes_macos() -> Result<(), String> {
    let output = Command::new("lsof")
        .args(["-nP", "-tiTCP:11434", "-sTCP:LISTEN"])
        .output()
        .map_err(|error| format!("failed to execute lsof for ollama port: {error}"))?;

    let pid_text = String::from_utf8_lossy(&output.stdout);
    for pid in pid_text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        let status = Command::new("kill")
            .args(["-9", pid])
            .status()
            .map_err(|error| format!("failed to kill ollama port pid {pid}: {error}"))?;
        if !status.success() {
            return Err(format!("kill -9 {pid} failed with status {status}"));
        }
    }

    Ok(())
}

#[cfg(target_os = "windows")]
fn kill_ollama_port_processes_windows() -> Result<(), String> {
    let output = Command::new("netstat")
        .args(["-ano"])
        .output()
        .map_err(|error| format!("failed to execute netstat for ollama port: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        if !(line.contains(":11434") && line.contains("LISTENING")) {
            continue;
        }
        let parts = line.split_whitespace().collect::<Vec<_>>();
        if let Some(pid) = parts.last() {
            let _ = Command::new("taskkill")
                .args(["/PID", pid, "/F", "/T"])
                .status();
        }
    }
    Ok(())
}

fn pull_ollama_model_impl(
    app: &AppHandle,
    child_state: &Arc<Mutex<Option<StdChild>>>,
    model: &str,
) -> Result<String, String> {
    let normalized_model = normalize_and_validate_ollama_model_name(model)?;
    let _ = append_launcher_log(
        app,
        "INFO",
        &format!("pull_ollama_model started model={normalized_model}"),
    );

    start_ollama_impl(app, child_state)?;

    let engine_dir = resolve_engine_dir(app)?;
    let ollama_binary = initialize_ollama_runtime(app, &engine_dir)?;
    let ollama_runtime_dir = ollama_binary
        .parent()
        .ok_or_else(|| String::from("bundled ollama binary has no parent directory"))?
        .to_path_buf();
    let models_dir = resolve_ollama_models_dir(app)?;

    let output = Command::new(&ollama_binary)
        .current_dir(&ollama_runtime_dir)
        .arg("pull")
        .arg(normalized_model)
        .env("OLLAMA_HOST", OLLAMA_HOST)
        .env("OLLAMA_MODELS", &models_dir)
        .output()
        .map_err(|error| format!("failed to pull ollama model: {error}"))?;

    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let _ = append_launcher_log(
            app,
            "INFO",
            &format!("pull_ollama_model succeeded model={normalized_model}"),
        );
        if stdout.is_empty() {
            return Ok(format!("Model `{normalized_model}` is ready."));
        }
        return Ok(stdout);
    }

    let stderr = sanitize_console_output(&String::from_utf8_lossy(&output.stderr));
    let stdout = sanitize_console_output(&String::from_utf8_lossy(&output.stdout));
    let _ = append_launcher_log(
        app,
        "ERROR",
        &format!(
            "pull_ollama_model failed model={normalized_model} stderr={stderr:?} stdout={stdout:?} status={}",
            output.status
        ),
    );
    if !stderr.is_empty() {
        Err(stderr)
    } else if !stdout.is_empty() {
        Err(stdout)
    } else {
        Err(format!("ollama pull exited with status {}", output.status))
    }
}

fn list_ollama_models_impl(
    app: &AppHandle,
    child_state: &Arc<Mutex<Option<StdChild>>>,
) -> Result<Vec<String>, String> {
    start_ollama_impl(app, child_state)?;

    let engine_dir = resolve_engine_dir(app)?;
    let ollama_binary = initialize_ollama_runtime(app, &engine_dir)?;
    let ollama_runtime_dir = ollama_binary
        .parent()
        .ok_or_else(|| String::from("bundled ollama binary has no parent directory"))?
        .to_path_buf();
    let models_dir = resolve_ollama_models_dir(app)?;

    let output = Command::new(&ollama_binary)
        .current_dir(&ollama_runtime_dir)
        .arg("list")
        .env("OLLAMA_HOST", OLLAMA_HOST)
        .env("OLLAMA_MODELS", &models_dir)
        .output()
        .map_err(|error| format!("failed to list ollama models: {error}"))?;

    if !output.status.success() {
        let stderr = sanitize_console_output(&String::from_utf8_lossy(&output.stderr));
        let stdout = sanitize_console_output(&String::from_utf8_lossy(&output.stdout));
        if !stderr.is_empty() {
            return Err(stderr);
        }
        if !stdout.is_empty() {
            return Err(stdout);
        }
        return Err(format!("ollama list exited with status {}", output.status));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut models = Vec::new();
    for line in stdout.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with("NAME") {
            continue;
        }
        if let Some(name) = trimmed.split_whitespace().next() {
            let candidate = name.trim();
            if !candidate.is_empty() && !models.iter().any(|existing| existing == candidate) {
                models.push(candidate.to_string());
            }
        }
    }

    Ok(models)
}

fn normalize_ollama_model_name_for_lookup(model: &str) -> String {
    let normalized_model = model.trim().to_ascii_lowercase();
    normalized_model
        .strip_suffix(":latest")
        .unwrap_or(&normalized_model)
        .to_string()
}

fn normalize_and_validate_ollama_model_name(model: &str) -> Result<&str, String> {
    let normalized_model = model.trim();
    if normalized_model.is_empty() {
        return Err(String::from("model name cannot be empty"));
    }
    if !looks_like_ollama_model_name(normalized_model) {
        return Err(String::from("model name format is invalid"));
    }
    if is_cloud_model_name(normalized_model) {
        return Err(String::from(
            "cloud models run remotely and cannot be used as local models",
        ));
    }
    Ok(normalized_model)
}

fn looks_like_ollama_model_name(model: &str) -> bool {
    if model.is_empty() || model.chars().any(char::is_whitespace) {
        return false;
    }

    if !model
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '/' | '.' | '_' | '-' | ':'))
    {
        return false;
    }

    let (repository, tag) = match model.rsplit_once(':') {
        Some((left, right)) => (left, Some(right)),
        None => (model, None),
    };

    if repository.is_empty()
        || repository.starts_with('/')
        || repository.ends_with('/')
        || repository.contains("//")
    {
        return false;
    }

    if repository
        .split('/')
        .any(|segment| segment.is_empty() || !segment.chars().any(|ch| ch.is_ascii_alphanumeric()))
    {
        return false;
    }

    match tag {
        Some(value) => !value.is_empty() && value.chars().any(|ch| ch.is_ascii_alphanumeric()),
        None => true,
    }
}

fn is_cloud_model_name(model: &str) -> bool {
    let normalized = model.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return false;
    }

    let (repository, tag) = match normalized.rsplit_once(':') {
        Some((left, right)) => (left, Some(right)),
        None => (normalized.as_str(), None),
    };

    repository.ends_with("-cloud")
        || matches!(tag, Some("cloud"))
        || matches!(tag, Some(value) if value.ends_with("-cloud"))
}

fn run_local_model_workflow_impl(
    app: &AppHandle,
    child_state: &Arc<Mutex<Option<StdChild>>>,
    progress_state: &Arc<Mutex<LocalModelRunProgress>>,
    pull_pid_state: &Arc<Mutex<Option<u32>>>,
    model: &str,
) -> Result<String, String> {
    let normalized_model = normalize_and_validate_ollama_model_name(model)?;

    start_ollama_impl(app, child_state)?;

    update_local_model_progress(progress_state, |progress| {
        progress.message = format!("Checking model `{normalized_model}`...");
    })?;

    run_ollama_pull_with_progress(app, normalized_model, progress_state, pull_pid_state)?;

    update_local_model_progress(progress_state, |progress| {
        progress.downloading = false;
        progress.has_known_progress = false;
        progress.progress = 0.0;
        progress.completed_bytes = None;
        progress.total_bytes = None;
        progress.speed_bytes_per_sec = None;
        progress.message = format!("Running `ollama run {normalized_model}`...");
    })?;

    let engine_dir = resolve_engine_dir(app)?;
    let ollama_binary = initialize_ollama_runtime(app, &engine_dir)?;
    let ollama_runtime_dir = ollama_binary
        .parent()
        .ok_or_else(|| String::from("bundled ollama binary has no parent directory"))?
        .to_path_buf();
    let models_dir = resolve_ollama_models_dir(app)?;

    let output = Command::new(&ollama_binary)
        .current_dir(&ollama_runtime_dir)
        .arg("run")
        .arg("--keepalive")
        .arg("10m")
        .arg(normalized_model)
        .arg("hello")
        .env("OLLAMA_HOST", OLLAMA_HOST)
        .env("OLLAMA_MODELS", &models_dir)
        .output()
        .map_err(|error| format!("failed to run ollama model: {error}"))?;

    if output.status.success() {
        return Ok(format!("Model `{normalized_model}` is ready."));
    }

    let stderr = sanitize_console_output(&String::from_utf8_lossy(&output.stderr));
    let stdout = sanitize_console_output(&String::from_utf8_lossy(&output.stdout));
    if !stderr.is_empty() {
        Err(stderr)
    } else if !stdout.is_empty() {
        Err(stdout)
    } else {
        Err(format!("ollama run exited with status {}", output.status))
    }
}

fn run_ollama_pull_with_progress(
    app: &AppHandle,
    model: &str,
    progress_state: &Arc<Mutex<LocalModelRunProgress>>,
    pull_pid_state: &Arc<Mutex<Option<u32>>>,
) -> Result<(), String> {
    let _ = append_launcher_log(
        app,
        "INFO",
        &format!("run_ollama_pull_with_progress started model={model}"),
    );
    let engine_dir = resolve_engine_dir(app)?;
    let ollama_binary = initialize_ollama_runtime(app, &engine_dir)?;
    let ollama_runtime_dir = ollama_binary
        .parent()
        .ok_or_else(|| String::from("bundled ollama binary has no parent directory"))?
        .to_path_buf();
    let models_dir = resolve_ollama_models_dir(app)?;

    let mut child = Command::new(&ollama_binary)
        .current_dir(&ollama_runtime_dir)
        .arg("pull")
        .arg(model)
        .env("OLLAMA_HOST", OLLAMA_HOST)
        .env("OLLAMA_MODELS", &models_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("failed to pull ollama model: {error}"))?;

    if let Ok(mut pull_pid) = pull_pid_state.lock() {
        *pull_pid = Some(child.id());
    }

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| String::from("failed to capture ollama pull stdout"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| String::from("failed to capture ollama pull stderr"))?;

    let stdout_state = progress_state.clone();
    let stderr_state = progress_state.clone();
    let stdout_handle = thread::spawn(move || consume_pull_output_stream(stdout, &stdout_state));
    let stderr_handle = thread::spawn(move || consume_pull_output_stream(stderr, &stderr_state));

    let status = child
        .wait()
        .map_err(|error| format!("failed to wait for ollama pull: {error}"))?;
    if let Ok(mut pull_pid) = pull_pid_state.lock() {
        *pull_pid = None;
    }
    let _ = stdout_handle.join();
    let _ = stderr_handle.join();

    if status.success() {
        let _ = append_launcher_log(
            app,
            "INFO",
            &format!("run_ollama_pull_with_progress succeeded model={model}"),
        );
        update_local_model_progress(progress_state, |progress| {
            progress.downloading = false;
            if progress.has_known_progress {
                progress.progress = 1.0;
            }
            if let Some(total_bytes) = progress.total_bytes {
                progress.completed_bytes = Some(total_bytes);
            }
            progress.speed_bytes_per_sec = None;
            progress.message = format!("Model `{model}` downloaded.");
        })?;
        return Ok(());
    }

    let _ = append_launcher_log(
        app,
        "ERROR",
        &format!("run_ollama_pull_with_progress failed model={model} status={status}"),
    );
    Err(build_ollama_pull_error(progress_state, status))
}

fn build_ollama_pull_error(
    progress_state: &Arc<Mutex<LocalModelRunProgress>>,
    status: std::process::ExitStatus,
) -> String {
    let fallback = format!("ollama pull exited with status {status}");
    let Ok(progress) = progress_state.lock() else {
        return fallback;
    };

    let message = progress.message.trim();
    if message.is_empty() || looks_like_transient_pull_status(message) {
        return fallback;
    }

    message.to_string()
}

fn looks_like_transient_pull_status(message: &str) -> bool {
    let normalized = message.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return true;
    }

    normalized.contains("pulling")
        || normalized.contains("downloading")
        || normalized.contains("verifying")
        || normalized.contains("writing")
        || normalized.contains("processing")
}

fn consume_pull_output_stream<R: Read>(
    mut reader: R,
    progress_state: &Arc<Mutex<LocalModelRunProgress>>,
) {
    let mut buffer = [0_u8; 4096];
    let mut pending = String::new();

    loop {
        let read_size = match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(size) => size,
            Err(_) => break,
        };

        pending.push_str(&String::from_utf8_lossy(&buffer[..read_size]));

        let mut start = 0;
        let chars: Vec<(usize, char)> = pending.char_indices().collect();
        for (byte_index, character) in chars {
            if character != '\n' && character != '\r' {
                continue;
            }
            let raw_line = &pending[start..byte_index];
            process_pull_output_line(raw_line, progress_state);
            start = byte_index + character.len_utf8();
        }

        if start > 0 {
            pending = pending[start..].to_string();
        }
    }

    if !pending.trim().is_empty() {
        process_pull_output_line(&pending, progress_state);
    }
}

fn process_pull_output_line(raw_line: &str, progress_state: &Arc<Mutex<LocalModelRunProgress>>) {
    let line = sanitize_console_line(raw_line);
    let line = line.trim();
    if line.is_empty() {
        return;
    }

    if let Ok(mut progress) = progress_state.lock() {
        progress.message = line.to_string();
        let line_lower = line.to_ascii_lowercase();
        if line_lower.contains("pulling")
            || line_lower.contains("downloading")
            || line.contains('%')
        {
            progress.downloading = true;
        }

        if let Some(percent) = extract_progress_percent(line) {
            progress.has_known_progress = true;
            progress.progress = (percent / 100.0).clamp(0.0, 1.0);
            progress.downloading = true;
        }

        if let Some((completed_bytes, total_bytes, speed_bps)) = extract_transfer_metrics(line) {
            if total_bytes > 0 && completed_bytes <= total_bytes {
                progress.completed_bytes = Some(completed_bytes);
                progress.total_bytes = Some(total_bytes);
                progress.speed_bytes_per_sec = speed_bps;
                progress.downloading = true;
                progress.has_known_progress = true;
                progress.progress =
                    (completed_bytes as f64 / total_bytes as f64).clamp(0.0, 1.0) as f32;
            }
        }
    }
}

fn sanitize_console_line(input: &str) -> String {
    let mut sanitized = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();

    while let Some(character) = chars.next() {
        if character == '\u{1b}' {
            if chars.peek().copied() == Some('[') {
                let _ = chars.next();
                while let Some(next_char) = chars.next() {
                    if ('@'..='~').contains(&next_char) {
                        break;
                    }
                }
                continue;
            }
            continue;
        }

        if character.is_control() && character != '\t' {
            continue;
        }

        sanitized.push(character);
    }

    sanitized
}

fn sanitize_console_output(input: &str) -> String {
    input
        .lines()
        .map(sanitize_console_line)
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn extract_progress_percent(line: &str) -> Option<f32> {
    let bytes = line.as_bytes();
    for index in 0..bytes.len() {
        if bytes[index] != b'%' || index == 0 {
            continue;
        }

        let mut start = index;
        while start > 0 && bytes[start - 1].is_ascii_digit() {
            start -= 1;
        }

        if start == index {
            continue;
        }

        let number = &line[start..index];
        if let Ok(value) = number.parse::<f32>() {
            if (0.0..=100.0).contains(&value) {
                return Some(value);
            }
        }
    }

    None
}

fn extract_transfer_metrics(line: &str) -> Option<(u64, u64, Option<f64>)> {
    let bytes = line.as_bytes();

    for (slash_index, byte) in bytes.iter().enumerate() {
        if *byte != b'/' {
            continue;
        }

        let Some((completed_bytes, _)) = extract_size_token_before(line, slash_index) else {
            continue;
        };
        let Some((total_bytes, right_end)) = extract_size_token_after(line, slash_index + 1) else {
            continue;
        };

        if total_bytes == 0 || completed_bytes > total_bytes {
            continue;
        }

        let speed_bps = extract_speed_metric(&line[right_end..]);
        return Some((completed_bytes, total_bytes, speed_bps));
    }

    None
}

fn parse_size_multiplier(unit: &str) -> Option<f64> {
    match unit.to_ascii_lowercase().as_str() {
        "b" => Some(1.0),
        "kb" | "kib" => Some(1024.0),
        "mb" | "mib" => Some(1024.0 * 1024.0),
        "gb" | "gib" => Some(1024.0 * 1024.0 * 1024.0),
        "tb" | "tib" => Some(1024.0 * 1024.0 * 1024.0 * 1024.0),
        _ => None,
    }
}

fn extract_size_token_before(line: &str, end_index: usize) -> Option<(u64, usize)> {
    let bytes = line.as_bytes();
    let mut cursor = end_index;

    while cursor > 0 && bytes[cursor - 1].is_ascii_whitespace() {
        cursor -= 1;
    }
    let unit_end = cursor;
    while cursor > 0 && bytes[cursor - 1].is_ascii_alphabetic() {
        cursor -= 1;
    }
    let unit_start = cursor;
    while cursor > 0 && bytes[cursor - 1].is_ascii_whitespace() {
        cursor -= 1;
    }
    let number_end = cursor;
    while cursor > 0 && (bytes[cursor - 1].is_ascii_digit() || bytes[cursor - 1] == b'.') {
        cursor -= 1;
    }
    let number_start = cursor;

    parse_size_token(&line[number_start..number_end], &line[unit_start..unit_end])
        .map(|bytes_value| (bytes_value, unit_end))
}

fn extract_size_token_after(line: &str, start_index: usize) -> Option<(u64, usize)> {
    let bytes = line.as_bytes();
    let mut cursor = start_index;

    while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
        cursor += 1;
    }
    let number_start = cursor;
    while cursor < bytes.len() && (bytes[cursor].is_ascii_digit() || bytes[cursor] == b'.') {
        cursor += 1;
    }
    let number_end = cursor;
    while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
        cursor += 1;
    }
    let unit_start = cursor;
    while cursor < bytes.len() && bytes[cursor].is_ascii_alphabetic() {
        cursor += 1;
    }
    let unit_end = cursor;

    parse_size_token(&line[number_start..number_end], &line[unit_start..unit_end])
        .map(|bytes_value| (bytes_value, unit_end))
}

fn extract_speed_metric(line: &str) -> Option<f64> {
    let chars: Vec<char> = line.chars().collect();
    let mut index = 0;

    while index < chars.len() {
        if !chars[index].is_ascii_digit() {
            index += 1;
            continue;
        }

        let number_start = index;
        while index < chars.len() && (chars[index].is_ascii_digit() || chars[index] == '.') {
            index += 1;
        }
        let number_end = index;

        while index < chars.len() && chars[index].is_ascii_whitespace() {
            index += 1;
        }

        let unit_start = index;
        while index < chars.len() && chars[index].is_ascii_alphabetic() {
            index += 1;
        }
        let unit_end = index;

        let suffix: String = chars[unit_end..chars.len().min(unit_end + 2)]
            .iter()
            .collect();
        if !suffix.eq_ignore_ascii_case("/s") {
            continue;
        }

        let number: String = chars[number_start..number_end].iter().collect();
        let unit: String = chars[unit_start..unit_end].iter().collect();
        let value = number.parse::<f64>().ok()?;
        let multiplier = parse_size_multiplier(&unit)?;
        return Some(value * multiplier);
    }

    None
}

fn parse_size_token(number: &str, unit: &str) -> Option<u64> {
    if number.is_empty() || unit.is_empty() {
        return None;
    }

    let value = number.parse::<f64>().ok()?;
    let multiplier = parse_size_multiplier(unit)?;
    Some((value * multiplier).round().max(0.0) as u64)
}

fn update_local_model_progress<F>(
    progress_state: &Arc<Mutex<LocalModelRunProgress>>,
    update: F,
) -> Result<(), String>
where
    F: FnOnce(&mut LocalModelRunProgress),
{
    let mut progress = progress_state
        .lock()
        .map_err(|_| String::from("failed to acquire local model progress lock"))?;
    update(&mut progress);
    Ok(())
}

#[cfg(unix)]
fn kill_process_by_pid(pid: u32) -> Result<(), String> {
    let status = Command::new("kill")
        .arg("-TERM")
        .arg(pid.to_string())
        .status()
        .map_err(|error| format!("failed to stop local model download pid {pid}: {error}"))?;

    if status.success() {
        Ok(())
    } else {
        Err(format!("kill -TERM {pid} failed with status {status}"))
    }
}

#[cfg(windows)]
fn kill_process_by_pid(pid: u32) -> Result<(), String> {
    let status = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .status()
        .map_err(|error| format!("failed to stop local model download pid {pid}: {error}"))?;

    if status.success() {
        Ok(())
    } else {
        Err(format!("taskkill /PID {pid} failed with status {status}"))
    }
}

fn wait_for_ollama_ready(child_slot: &mut Option<StdChild>) -> Result<(), String> {
    let address = format!("127.0.0.1:{OLLAMA_PORT}");

    for _ in 0..HEALTH_CHECK_ATTEMPTS {
        if let Some(process) = child_slot.as_mut() {
            if let Some(status) = process
                .try_wait()
                .map_err(|error| format!("failed to inspect ollama process state: {error}"))?
            {
                return Err(format!("Bundled Ollama exited early with status {status}."));
            }
        }

        if std::net::TcpStream::connect(&address).is_ok() {
            return Ok(());
        }

        thread::sleep(Duration::from_millis(HEALTH_CHECK_DELAY_MS));
    }

    Err(format!(
        "Bundled Ollama did not become ready at http://{OLLAMA_HOST}/ in time."
    ))
}

fn build_ollama_status(
    app: &AppHandle,
    pid: Option<u32>,
    running: bool,
) -> Result<OllamaStatus, String> {
    let models_dir = resolve_ollama_models_dir(app)?;
    Ok(OllamaStatus {
        running,
        pid,
        url: format!("http://{OLLAMA_HOST}/"),
        models_dir: models_dir.display().to_string(),
        version: read_bundled_ollama_version(app).ok(),
    })
}

fn resolve_engine_dir(app: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    {
        let workspace_engine_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .map(|path| path.join("whereclaw-engine"))
            .ok_or_else(|| String::from("failed to resolve workspace engine directory"))?;

        if workspace_engine_dir.exists() {
            return Ok(workspace_engine_dir);
        }
    }

    let engine_dir = app
        .path()
        .resolve("whereclaw-engine", BaseDirectory::Resource)
        .map_err(|error| format!("failed to resolve engine resource directory: {error}"))?;

    if !engine_dir.exists() {
        return Err(format!(
            "bundled engine directory not found: {}",
            engine_dir.display()
        ));
    }

    Ok(engine_dir)
}

fn resolve_node_binary(engine_dir: &Path) -> Result<PathBuf, String> {
    let node_binary = resolve_runtime_bin_dir(engine_dir)?.join(node_binary_name());

    if !node_binary.exists() {
        return Err(format!(
            "bundled Node binary not found: {}",
            node_binary.display()
        ));
    }

    Ok(node_binary)
}

fn resolve_runtime_bin_dir(engine_dir: &Path) -> Result<PathBuf, String> {
    let runtime_dir = engine_dir.join("node-runtime");
    let runtime_bin_dir = if cfg!(target_os = "windows") {
        runtime_dir
    } else {
        runtime_dir.join("bin")
    };

    if !runtime_bin_dir.exists() {
        return Err(format!(
            "bundled Node runtime directory not found: {}",
            runtime_bin_dir.display()
        ));
    }

    Ok(runtime_bin_dir)
}

fn resolve_bundled_ollama_dir(engine_dir: &Path) -> Result<PathBuf, String> {
    let bundled_dir = engine_dir.join("ollama").join(ollama_platform_dir_name());

    if !bundled_dir.exists() {
        return Err(format!(
            "bundled ollama runtime directory not found: {}",
            bundled_dir.display()
        ));
    }

    Ok(bundled_dir)
}

fn initialize_ollama_runtime(app: &AppHandle, engine_dir: &Path) -> Result<PathBuf, String> {
    let bundled_dir = resolve_bundled_ollama_dir(engine_dir)?;
    let runtime_dir = resolve_ollama_runtime_dir(app)?;
    let bundled_version = fs::read_to_string(engine_dir.join("ollama").join("VERSION"))
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let runtime_version_path = runtime_dir.join("VERSION");
    let runtime_version = fs::read_to_string(&runtime_version_path)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let runtime_binary = runtime_dir.join(ollama_binary_name());

    if !runtime_binary.exists() || bundled_version != runtime_version {
        if runtime_dir.exists() {
            fs::remove_dir_all(&runtime_dir).map_err(|error| {
                format!(
                    "failed to remove outdated ollama runtime directory {}: {error}",
                    runtime_dir.display()
                )
            })?;
        }

        copy_dir_recursive(&bundled_dir, &runtime_dir)?;

        if let Some(version) = bundled_version {
            fs::write(&runtime_version_path, format!("{version}\n")).map_err(|error| {
                format!("failed to write ollama runtime version marker: {error}")
            })?;
        }
    }

    if !runtime_binary.exists() {
        return Err(format!(
            "bundled ollama binary not found after runtime sync: {}",
            runtime_binary.display()
        ));
    }

    #[cfg(target_os = "macos")]
    {
        let metadata = fs::metadata(&runtime_binary)
            .map_err(|error| format!("failed to inspect ollama binary permissions: {error}"))?;
        let mut permissions = metadata.permissions();
        use std::os::unix::fs::PermissionsExt;
        permissions.set_mode(0o755);
        fs::set_permissions(&runtime_binary, permissions)
            .map_err(|error| format!("failed to mark ollama binary executable: {error}"))?;
    }

    Ok(runtime_binary)
}

fn resolve_openclaw_entry(engine_dir: &Path) -> Result<PathBuf, String> {
    let bundled_entry = engine_dir
        .join("openclaw")
        .join("node_modules")
        .join("openclaw-cn")
        .join("dist")
        .join("entry.js");

    if bundled_entry.exists() {
        return Ok(bundled_entry);
    }

    let legacy_entry = engine_dir
        .join("openclaw")
        .join("node_modules")
        .join("openclaw")
        .join("openclaw.mjs");

    if legacy_entry.exists() {
        return Ok(legacy_entry);
    }

    Err(format!(
        "bundled OpenClaw entry script not found: {} or {}",
        bundled_entry.display(),
        legacy_entry.display()
    ))
}

fn resolve_openclaw_package_root(entry_script: &Path) -> Result<PathBuf, String> {
    let entry_parent = entry_script.parent().ok_or_else(|| {
        format!(
            "bundled OpenClaw entry script has no parent directory: {}",
            entry_script.display()
        )
    })?;

    let package_root = if entry_parent.file_name() == Some(OsStr::new("dist")) {
        entry_parent.parent().ok_or_else(|| {
            format!(
                "bundled OpenClaw dist directory has no package root: {}",
                entry_script.display()
            )
        })?
    } else {
        entry_parent
    };

    Ok(package_root.to_path_buf())
}

fn resolve_openclaw_home_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let preferences = read_launcher_preferences_impl(app)?;
    Ok(PathBuf::from(preferences.install_dir))
}

fn resolve_launcher_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map_err(|error| format!("failed to resolve local data directory: {error}"))
}

fn resolve_launcher_logs_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(resolve_launcher_data_dir(app)?.join("logs"))
}

fn resolve_launcher_log_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(resolve_launcher_logs_dir(app)?.join(LAUNCHER_LOG_FILE_NAME))
}

fn resolve_gateway_log_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    let openclaw_home = resolve_openclaw_home_dir(app)?;
    Ok(openclaw_home.join("logs").join(GATEWAY_LOG_FILE_NAME))
}

fn resolve_log_file_path(app: &AppHandle, source: Option<&str>) -> Result<PathBuf, String> {
    match source.unwrap_or("launcher") {
        "launcher" => Ok(resolve_launcher_logs_dir(app)?.join(LAUNCHER_LOG_FILE_NAME)),
        "ollama" => Ok(resolve_launcher_logs_dir(app)?.join(OLLAMA_LOG_FILE_NAME)),
        "gateway" => resolve_gateway_log_file_path(app),
        other => Err(format!("unknown log source: {other}")),
    }
}

fn read_launcher_logs_impl(app: &AppHandle, source: Option<&str>) -> Result<String, String> {
    let path = resolve_log_file_path(app, source)?;
    if !path.exists() {
        return Ok(String::new());
    }
    fs::read_to_string(&path).map_err(|error| format!("failed to read launcher log file: {error}"))
}

fn append_frontend_log_impl(
    app: &AppHandle,
    level: &str,
    message: &str,
    context: Option<&Value>,
) -> Result<(), String> {
    let normalized_level = level.trim().to_ascii_uppercase();
    let context_json = context
        .and_then(|value| serde_json::to_string(value).ok())
        .unwrap_or_else(|| String::from("null"));
    append_launcher_log(
        app,
        &normalized_level,
        &format!("frontend_status message={message:?} context={context_json}"),
    )
}

fn append_launcher_log(app: &AppHandle, level: &str, message: &str) -> Result<(), String> {
    let logs_dir = resolve_launcher_logs_dir(app)?;
    fs::create_dir_all(&logs_dir)
        .map_err(|error| format!("failed to create launcher logs directory: {error}"))?;
    let log_path = resolve_launcher_log_file_path(app)?;
    rotate_launcher_log_if_needed(&log_path)?;

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    let sanitized = sanitize_console_output(message);
    let line = format!("[{timestamp}] [{level}] {sanitized}\n");

    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|error| format!("failed to open launcher log file: {error}"))?;
    file.write_all(line.as_bytes())
        .map_err(|error| format!("failed to write launcher log file: {error}"))
}

fn rotate_launcher_log_if_needed(log_path: &Path) -> Result<(), String> {
    let Ok(metadata) = fs::metadata(log_path) else {
        return Ok(());
    };
    if metadata.len() < LAUNCHER_LOG_MAX_BYTES {
        return Ok(());
    }

    for index in (1..=LAUNCHER_LOG_KEEP_FILES).rev() {
        let source = if index == 1 {
            log_path.to_path_buf()
        } else {
            PathBuf::from(format!("{}.{}", log_path.display(), index - 1))
        };
        let target = PathBuf::from(format!("{}.{}", log_path.display(), index));

        if !source.exists() {
            continue;
        }

        if index == LAUNCHER_LOG_KEEP_FILES && target.exists() {
            let _ = fs::remove_file(&target);
        }

        fs::rename(&source, &target).map_err(|error| {
            format!(
                "failed to rotate launcher log file {}: {error}",
                source.display()
            )
        })?;
    }

    Ok(())
}

fn resolve_ollama_runtime_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(resolve_launcher_data_dir(app)?.join("ollama-runtime"))
}

fn resolve_ollama_models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let models_dir = resolve_launcher_data_dir(app)?.join("ollama-models");
    fs::create_dir_all(&models_dir)
        .map_err(|error| format!("failed to create ollama models directory: {error}"))?;
    Ok(models_dir)
}

fn read_bundled_ollama_version(app: &AppHandle) -> Result<String, String> {
    let version_path = resolve_engine_dir(app)?.join("ollama").join("VERSION");
    let version = fs::read_to_string(&version_path)
        .map_err(|error| format!("failed to read bundled ollama version: {error}"))?;
    let trimmed = version.trim();
    if trimmed.is_empty() {
        return Err(String::from("bundled ollama version file is empty"));
    }
    Ok(String::from(trimmed))
}

fn resolve_default_openclaw_home_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(resolve_launcher_data_dir(app)?.join("openclaw-home"))
}

fn resolve_launcher_settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(resolve_launcher_data_dir(app)?.join("launcher-settings.json"))
}

fn resolve_remote_skills_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(resolve_launcher_data_dir(app)?.join(REMOTE_SKILLS_DIR_NAME))
}

fn resolve_remote_skills_catalog_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(resolve_remote_skills_dir(app)?.join(REMOTE_SKILLS_FILE_NAME))
}

fn resolve_remote_skills_metadata_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(resolve_remote_skills_dir(app)?.join(REMOTE_SKILLS_METADATA_FILE_NAME))
}

fn read_cached_skill_catalog_metadata(app: &AppHandle) -> Result<Option<CachedSkillCatalogMetadata>, String> {
    let path = resolve_remote_skills_metadata_path(app)?;
    if !path.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(&path)
        .map_err(|error| format!("failed to read cached skills metadata: {error}"))?;
    let metadata = serde_json::from_str(&text)
        .map_err(|error| format!("failed to parse cached skills metadata: {error}"))?;
    Ok(Some(metadata))
}

fn read_active_skill_catalog_impl(app: &AppHandle) -> Result<ActiveSkillCatalogPayload, String> {
    let metadata = read_cached_skill_catalog_metadata(app)?;
    let catalog_path = resolve_remote_skills_catalog_path(app)?;

    if let Some(metadata) = metadata {
        if catalog_path.exists() {
            let text = fs::read_to_string(&catalog_path)
                .map_err(|error| format!("failed to read cached skills catalog: {error}"))?;
            let catalog = serde_json::from_str(&text)
                .map_err(|error| format!("failed to parse cached skills catalog: {error}"))?;
            return Ok(ActiveSkillCatalogPayload {
                version: metadata.version,
                source: String::from("cached"),
                catalog,
            });
        }
    }

    read_bundled_skill_catalog()
}

fn read_remote_notifications_impl(app: &AppHandle) -> Result<RemoteNotificationsPayload, String> {
    let notifications = read_cached_skill_catalog_metadata(app)?
        .map(|metadata| metadata.notifications)
        .unwrap_or_else(empty_cached_notifications);

    Ok(RemoteNotificationsPayload {
        cn: notifications.cn,
        en: notifications.en,
        source: String::from("cached"),
    })
}

fn read_remote_desktop_version_impl(app: &AppHandle) -> Result<RemoteDesktopVersionPayload, String> {
    let current_version = current_desktop_version(app);
    let remote_version = read_cached_skill_catalog_metadata(app)?
        .and_then(|metadata| metadata.desktop_version);

    Ok(RemoteDesktopVersionPayload {
        update_available: is_remote_desktop_version_newer(remote_version.as_deref(), &current_version),
        version: remote_version,
        source: String::from("cached"),
    })
}

fn write_cached_skill_catalog(
    app: &AppHandle,
    version: &str,
    url: &str,
    desktop_version: Option<&str>,
    notifications: CachedNotifications,
    catalog_text: &str,
) -> Result<(), String> {
    let dir = resolve_remote_skills_dir(app)?;
    fs::create_dir_all(&dir)
        .map_err(|error| format!("failed to create remote skills cache directory: {error}"))?;

    let catalog_value: Value = serde_json::from_str(catalog_text)
        .map_err(|error| format!("failed to parse downloaded skills catalog: {error}"))?;
    let metadata = CachedSkillCatalogMetadata {
        version: String::from(version),
        url: String::from(url),
        desktop_version: desktop_version.map(String::from),
        notifications,
    };

    fs::write(
        resolve_remote_skills_catalog_path(app)?,
        serde_json::to_string(&catalog_value)
            .map_err(|error| format!("failed to serialize cached skills catalog: {error}"))?,
    )
    .map_err(|error| format!("failed to write cached skills catalog: {error}"))?;

    fs::write(
        resolve_remote_skills_metadata_path(app)?,
        serde_json::to_string(&metadata)
            .map_err(|error| format!("failed to serialize cached skills metadata: {error}"))?,
    )
    .map_err(|error| format!("failed to write cached skills metadata: {error}"))?;

    Ok(())
}

fn write_cached_skill_catalog_metadata(
    app: &AppHandle,
    version: &str,
    url: &str,
    desktop_version: Option<&str>,
    notifications: CachedNotifications,
) -> Result<(), String> {
    let dir = resolve_remote_skills_dir(app)?;
    fs::create_dir_all(&dir)
        .map_err(|error| format!("failed to create remote skills cache directory: {error}"))?;

    let metadata = CachedSkillCatalogMetadata {
        version: String::from(version),
        url: String::from(url),
        desktop_version: desktop_version.map(String::from),
        notifications,
    };

    fs::write(
        resolve_remote_skills_metadata_path(app)?,
        serde_json::to_string(&metadata)
            .map_err(|error| format!("failed to serialize cached skills metadata: {error}"))?,
    )
    .map_err(|error| format!("failed to write cached skills metadata: {error}"))?;

    Ok(())
}

fn ensure_remote_skill_catalog_fresh_impl(
    app: &AppHandle,
) -> Result<SkillCatalogRefreshResult, String> {
    let active_before = read_active_skill_catalog_impl(app)?;
    let current_desktop_version = current_desktop_version(app);
    let cached_desktop_version_before = read_cached_skill_catalog_metadata(app)?
        .and_then(|metadata| metadata.desktop_version);
    let desktop_update_available_before = is_remote_desktop_version_newer(
        cached_desktop_version_before.as_deref(),
        &current_desktop_version,
    );
    let client = Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|error| format!("failed to initialize remote skills client: {error}"))?;

    let manifest_response = match client.get(REMOTE_SKILLS_MANIFEST_URL).send() {
        Ok(response) => response,
        Err(error) => {
            let _ = append_launcher_log(
                app,
                "WARN",
                &format!("remote skills manifest request failed: {error}"),
            );
            return Ok(SkillCatalogRefreshResult {
                version: active_before.version,
                source: active_before.source,
                updated: false,
                desktop_version: cached_desktop_version_before,
                desktop_update_available: desktop_update_available_before,
            });
        }
    };

    if !manifest_response.status().is_success() {
        let _ = append_launcher_log(
            app,
            "WARN",
            &format!(
                "remote skills manifest request failed: HTTP {}",
                manifest_response.status()
            ),
        );
        return Ok(SkillCatalogRefreshResult {
            version: active_before.version,
            source: active_before.source,
            updated: false,
            desktop_version: cached_desktop_version_before,
            desktop_update_available: desktop_update_available_before,
        });
    }

    let manifest_text = match manifest_response.text() {
        Ok(text) => text,
        Err(error) => {
            let _ = append_launcher_log(
                app,
                "WARN",
                &format!("failed to read remote skills manifest body: {error}"),
            );
            return Ok(SkillCatalogRefreshResult {
                version: active_before.version,
                source: active_before.source,
                updated: false,
                desktop_version: cached_desktop_version_before,
                desktop_update_available: desktop_update_available_before,
            });
        }
    };

    let manifest: RemoteManifest = match serde_json::from_str(&manifest_text) {
        Ok(manifest) => manifest,
        Err(error) => {
            let _ = append_launcher_log(
                app,
                "WARN",
                &format!("failed to parse remote skills manifest: {error}"),
            );
            return Ok(SkillCatalogRefreshResult {
                version: active_before.version,
                source: active_before.source,
                updated: false,
                desktop_version: cached_desktop_version_before,
                desktop_update_available: desktop_update_available_before,
            });
        }
    };

    let remote_desktop_version = manifest
        .desktop
        .map(|desktop| desktop.version.trim().to_string())
        .filter(|version| !version.is_empty());
    let desktop_update_available = is_remote_desktop_version_newer(
        remote_desktop_version.as_deref(),
        &current_desktop_version,
    );

    let notifications = manifest
        .notifications
        .map(|notifications| CachedNotifications {
            cn: notifications.cn,
            en: notifications.en,
        })
        .unwrap_or_else(empty_cached_notifications);

    let Some(skills_manifest) = manifest.skills else {
        let _ = append_launcher_log(app, "WARN", "remote skills manifest missing skills section");
        return Ok(SkillCatalogRefreshResult {
            version: active_before.version,
            source: active_before.source,
            updated: false,
            desktop_version: remote_desktop_version,
            desktop_update_available: desktop_update_available,
        });
    };

    let remote_version = skills_manifest.version.trim();
    let remote_url = skills_manifest.url.trim();
    if remote_version.is_empty() || remote_url.is_empty() {
        let _ = append_launcher_log(app, "WARN", "remote skills manifest has empty version or URL");
        return Ok(SkillCatalogRefreshResult {
            version: active_before.version,
            source: active_before.source,
            updated: false,
            desktop_version: remote_desktop_version.clone(),
            desktop_update_available: desktop_update_available,
        });
    }

    let needs_update = match is_remote_version_newer(remote_version, &active_before.version) {
        Ok(value) => value,
        Err(error) => {
            let _ = append_launcher_log(
                app,
                "WARN",
                &format!("failed to compare remote skills version: {error}"),
            );
            false
        }
    };

    if !needs_update {
        let metadata_version = read_cached_skill_catalog_metadata(app)?
            .map(|metadata| metadata.version)
            .unwrap_or_else(|| active_before.version.clone());
        let metadata_url = read_cached_skill_catalog_metadata(app)?
            .map(|metadata| metadata.url)
            .unwrap_or_else(|| String::from(remote_url));
        let _ = write_cached_skill_catalog_metadata(
            app,
            &metadata_version,
            &metadata_url,
            remote_desktop_version.as_deref(),
            notifications,
        );
        return Ok(SkillCatalogRefreshResult {
            version: active_before.version,
            source: active_before.source,
            updated: false,
            desktop_version: remote_desktop_version,
            desktop_update_available: desktop_update_available,
        });
    }

    let skills_response = match client.get(remote_url).send() {
        Ok(response) => response,
        Err(error) => {
            let _ = append_launcher_log(
                app,
                "WARN",
                &format!("remote skills catalog download failed: {error}"),
            );
            return Ok(SkillCatalogRefreshResult {
                version: active_before.version,
                source: active_before.source,
                updated: false,
                desktop_version: remote_desktop_version.clone(),
                desktop_update_available: desktop_update_available,
            });
        }
    };

    if !skills_response.status().is_success() {
        let _ = append_launcher_log(
            app,
            "WARN",
            &format!(
                "remote skills catalog download failed: HTTP {}",
                skills_response.status()
            ),
        );
        return Ok(SkillCatalogRefreshResult {
            version: active_before.version,
            source: active_before.source,
            updated: false,
            desktop_version: remote_desktop_version.clone(),
            desktop_update_available: desktop_update_available,
        });
    }

    let catalog_text = match skills_response.text() {
        Ok(text) => text,
        Err(error) => {
            let _ = append_launcher_log(
                app,
                "WARN",
                &format!("failed to read remote skills catalog body: {error}"),
            );
            return Ok(SkillCatalogRefreshResult {
                version: active_before.version,
                source: active_before.source,
                updated: false,
                desktop_version: remote_desktop_version.clone(),
                desktop_update_available: desktop_update_available,
            });
        }
    };

    if let Err(error) = write_cached_skill_catalog(
        app,
        remote_version,
        remote_url,
        remote_desktop_version.as_deref(),
        notifications,
        &catalog_text,
    ) {
        let _ = append_launcher_log(
            app,
            "WARN",
            &format!("failed to persist remote skills catalog: {error}"),
        );
        return Ok(SkillCatalogRefreshResult {
            version: active_before.version,
            source: active_before.source,
            updated: false,
            desktop_version: remote_desktop_version,
            desktop_update_available: desktop_update_available,
        });
    }

    let active_after = read_active_skill_catalog_impl(app)?;
    let _ = append_launcher_log(
        app,
        "INFO",
        &format!("remote skills catalog updated to version {}", active_after.version),
    );

    Ok(SkillCatalogRefreshResult {
        version: active_after.version,
        source: active_after.source,
        updated: true,
        desktop_version: read_cached_skill_catalog_metadata(app)?
            .and_then(|metadata| metadata.desktop_version),
        desktop_update_available: read_remote_desktop_version_impl(app)?.update_available,
    })
}

fn read_setup_info_impl(app: &AppHandle) -> Result<SetupInfo, String> {
    let engine_dir = resolve_engine_dir(app)?;
    let openclaw_home = initialize_openclaw_home(app, &engine_dir)?;
    let config = read_openclaw_config(&openclaw_home)?;
    let current_model_ref =
        string_at_path(&config, &["agents", "defaults", "model", "primary"]).unwrap_or_default();
    let (current_model_provider, current_model_name, current_model_is_local) =
        summarize_current_model_ref(&current_model_ref);

    Ok(SetupInfo {
        configured: is_configured(&config),
        openclaw_home: openclaw_home.display().to_string(),
        config_path: openclaw_home.join("openclaw.json").display().to_string(),
        current_model_ref,
        current_model_name,
        current_model_provider,
        current_model_is_local,
    })
}

fn summarize_current_model_ref(model_ref: &str) -> (String, String, bool) {
    let trimmed = model_ref.trim();
    if trimmed.is_empty() {
        return (String::new(), String::new(), false);
    }

    if let Some((provider, model_name)) = trimmed.split_once('/') {
        let normalized_provider = provider.trim().to_string();
        let normalized_model_name = model_name.trim().to_string();
        let is_local = normalized_provider == "ollama";
        return (normalized_provider, normalized_model_name, is_local);
    }

    (String::from("unknown"), String::from(trimmed), false)
}

fn read_launcher_preferences_impl(app: &AppHandle) -> Result<LauncherPreferences, String> {
    let default_install_dir = resolve_default_openclaw_home_dir(app)?;
    let settings_path = resolve_launcher_settings_path(app)?;

    if !settings_path.exists() {
        return Ok(LauncherPreferences {
            language: String::from("en"),
            install_dir: default_install_dir.display().to_string(),
            has_saved_preferences: false,
            is_initialized: false,
            is_initialization_in_progress: false,
        });
    }

    let settings_text = fs::read_to_string(&settings_path)
        .map_err(|error| format!("failed to read launcher settings: {error}"))?;
    let stored: StoredLauncherPreferences = serde_json::from_str(&settings_text)
        .map_err(|error| format!("failed to parse launcher settings: {error}"))?;
    let language = normalize_launcher_language(&stored.language)?;
    let install_dir = normalize_install_dir(&stored.install_dir)?;

    Ok(LauncherPreferences {
        language: String::from(language),
        install_dir: install_dir.display().to_string(),
        has_saved_preferences: true,
        is_initialized: stored.is_initialized,
        is_initialization_in_progress: stored.is_initialization_in_progress,
    })
}

fn save_launcher_preferences_impl(
    app: &AppHandle,
    language: &str,
    install_dir: &str,
    is_initialized: Option<bool>,
    is_initialization_in_progress: Option<bool>,
) -> Result<LauncherPreferences, String> {
    let language = normalize_launcher_language(language)?;
    let install_dir = normalize_install_dir(install_dir)?;
    let existing = read_launcher_preferences_impl(app).ok();
    let settings_path = resolve_launcher_settings_path(app)?;
    let settings_dir = settings_path
        .parent()
        .ok_or_else(|| String::from("failed to determine launcher settings directory"))?;

    fs::create_dir_all(settings_dir)
        .map_err(|error| format!("failed to create launcher settings directory: {error}"))?;
    fs::create_dir_all(&install_dir)
        .map_err(|error| format!("failed to create install directory: {error}"))?;

    let stored = StoredLauncherPreferences {
        language: String::from(language),
        install_dir: install_dir.display().to_string(),
        is_initialized: is_initialized.unwrap_or_else(|| {
            existing
                .as_ref()
                .map(|preferences| preferences.is_initialized)
                .unwrap_or(false)
        }),
        is_initialization_in_progress: is_initialization_in_progress.unwrap_or_else(|| {
            existing
                .as_ref()
                .map(|preferences| preferences.is_initialization_in_progress)
                .unwrap_or(false)
        }),
    };
    let content = serde_json::to_string_pretty(&stored)
        .map_err(|error| format!("failed to serialize launcher settings: {error}"))?;
    fs::write(&settings_path, format!("{content}\n"))
        .map_err(|error| format!("failed to write launcher settings: {error}"))?;
    let _ = append_launcher_log(
        app,
        "INFO",
        &format!(
            "save_launcher_preferences language={language} install_dir={} initialized={} initialization_in_progress={}",
            install_dir.display(),
            stored.is_initialized,
            stored.is_initialization_in_progress
        ),
    );

    read_launcher_preferences_impl(app)
}

fn list_channel_accounts_impl(app: &AppHandle) -> Result<Vec<ChannelAccount>, String> {
    let payload = run_openclaw_json_command(app, &["channels", "list", "--json"])?;
    let chat = payload
        .get("chat")
        .and_then(Value::as_object)
        .ok_or_else(|| String::from("official channels list did not return a `chat` object"))?;

    let mut accounts = Vec::new();
    for (channel, value) in chat {
        let Some(account_ids) = value.as_array() else {
            continue;
        };

        for account_id in account_ids.iter().filter_map(Value::as_str) {
            accounts.push(ChannelAccount {
                channel: channel.clone(),
                account_id: String::from(account_id),
            });
        }
    }

    accounts.sort_by(|left, right| {
        left.channel
            .cmp(&right.channel)
            .then(left.account_id.cmp(&right.account_id))
    });
    Ok(accounts)
}

fn remove_channel_account_impl(
    app: &AppHandle,
    channel: &str,
    account_id: &str,
) -> Result<(), String> {
    let normalized_channel = channel.trim();
    let normalized_account_id = account_id.trim();
    if normalized_channel.is_empty() {
        return Err(String::from("channel cannot be empty"));
    }
    if normalized_account_id.is_empty() {
        return Err(String::from("account id cannot be empty"));
    }

    let mut args = vec![
        "channels",
        "remove",
        "--channel",
        normalized_channel,
        "--delete",
    ];
    if normalized_account_id != "default" {
        args.push("--account");
        args.push(normalized_account_id);
    }

    run_openclaw_command(app, &args)?;
    let _ = append_launcher_log(
        app,
        "INFO",
        &format!(
            "remove_channel_account channel={normalized_channel} account_id={normalized_account_id}"
        ),
    );

    let still_present = list_channel_accounts_impl(app)?.iter().any(|entry| {
        entry.channel == normalized_channel && entry.account_id == normalized_account_id
    });
    if still_present {
        cleanup_channel_residues(app, normalized_channel)?;
    }

    Ok(())
}

fn list_openclaw_models_impl(app: &AppHandle) -> Result<Vec<ModelCatalogEntry>, String> {
    let openclaw_home = resolve_openclaw_home_dir(app)?;
    let config = read_openclaw_config(&openclaw_home)?;
    let selected_model_refs = collect_selected_model_refs(&config);
    let current_primary =
        string_at_path(&config, &["agents", "defaults", "model", "primary"]).unwrap_or_default();
    if selected_model_refs.is_empty() {
        return Ok(Vec::new());
    }

    let payload = run_openclaw_json_command(app, &["models", "list", "--all", "--json"])?;
    let models = payload
        .get("models")
        .and_then(Value::as_array)
        .ok_or_else(|| String::from("official models list did not return a `models` array"))?;
    let model_map = models
        .iter()
        .filter_map(Value::as_object)
        .filter_map(|model_obj| {
            model_obj
                .get("key")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|key| !key.is_empty())
                .map(|key| (String::from(key), model_obj))
        })
        .collect::<HashMap<_, _>>();

    let mut entries = Vec::new();
    for model_ref in selected_model_refs {
        let trimmed_key = model_ref.trim();
        if trimmed_key.is_empty() {
            continue;
        }

        let (provider, model_id) = trimmed_key
            .split_once('/')
            .map(|(left, right)| (left.trim(), right.trim()))
            .unwrap_or(("", trimmed_key));
        let normalized_provider = if provider.is_empty() {
            "unknown"
        } else {
            provider
        };
        let normalized_model_id = if model_id.is_empty() {
            trimmed_key
        } else {
            model_id
        };

        let model_obj = model_map.get(trimmed_key).copied();
        let name = model_obj
            .and_then(|value| value.get("name"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(normalized_model_id);
        let input = model_obj
            .and_then(|value| value.get("input"))
            .and_then(Value::as_str)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let context_window = model_obj
            .and_then(|value| value.get("contextWindow"))
            .and_then(Value::as_u64);
        let local = model_obj
            .and_then(|value| value.get("local"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let available = model_obj
            .and_then(|value| value.get("available"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let missing = model_obj
            .and_then(|value| value.get("missing"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let tags = model_obj
            .and_then(|value| value.get("tags"))
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        entries.push(ModelCatalogEntry {
            key: String::from(trimmed_key),
            provider: String::from(normalized_provider),
            model_id: String::from(normalized_model_id),
            name: String::from(name),
            input,
            context_window,
            local,
            available,
            tags,
            missing,
            is_current: trimmed_key == current_primary.trim(),
        });
    }

    entries.sort_by(|left, right| {
        left.provider
            .cmp(&right.provider)
            .then(left.model_id.cmp(&right.model_id))
    });
    Ok(entries)
}

fn list_installed_skills_impl(app: &AppHandle) -> Result<Vec<InstalledSkillEntry>, String> {
    let openclaw_home = resolve_openclaw_home_dir(app)?;
    let engine_dir = resolve_engine_dir(app)?;
    let config = read_openclaw_config(&openclaw_home)?;
    let workspace_skills_dir = openclaw_home
        .join(".openclaw")
        .join("workspace")
        .join("skills");
    let managed_skills_dir = openclaw_home.join(".openclaw").join("skills");
    let bundled_skills_dir = engine_dir
        .join("openclaw")
        .join("node_modules")
        .join("openclaw-cn")
        .join("skills");

    let mut entries = Vec::new();
    collect_skill_entries(&workspace_skills_dir, "workspace", &config, &mut entries)?;
    collect_skill_entries(&managed_skills_dir, "managed", &config, &mut entries)?;
    collect_skill_entries(&bundled_skills_dir, "bundled", &config, &mut entries)?;

    entries.sort_by(|left, right| {
        source_sort_key(&left.source)
            .cmp(&source_sort_key(&right.source))
            .then(left.title.cmp(&right.title))
            .then(left.id.cmp(&right.id))
    });

    Ok(entries)
}

fn source_sort_key(source: &str) -> u8 {
    match source {
        "workspace" => 0,
        "managed" => 1,
        "bundled" => 2,
        _ => 3,
    }
}

fn collect_skill_entries(
    root: &Path,
    source: &str,
    config: &Value,
    entries: &mut Vec<InstalledSkillEntry>,
) -> Result<(), String> {
    if !root.exists() {
        return Ok(());
    }

    let read_dir =
        fs::read_dir(root).map_err(|error| format!("failed to read skills directory: {error}"))?;
    for entry in read_dir {
        let entry =
            entry.map_err(|error| format!("failed to inspect installed skill entry: {error}"))?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        let skill_path = path.join("SKILL.md");
        if !skill_path.exists() {
            continue;
        }

        let id = path
            .file_name()
            .and_then(OsStr::to_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| format!("invalid skill directory name: {}", path.display()))?;
        let markdown = fs::read_to_string(&skill_path).map_err(|error| {
            format!(
                "failed to read skill file {}: {error}",
                skill_path.display()
            )
        })?;
        let (skill_key, title, description) = summarize_skill_markdown(id, &markdown);
        let enabled = read_skill_enabled(config, &skill_key);

        entries.push(InstalledSkillEntry {
            id: String::from(id),
            skill_key,
            title,
            description,
            source: String::from(source),
            path: path.display().to_string(),
            has_references: path.join("references").is_dir(),
            has_scripts: path.join("scripts").is_dir(),
            enabled,
        });
    }

    Ok(())
}

fn summarize_skill_markdown(skill_id: &str, markdown: &str) -> (String, String, Option<String>) {
    let mut in_frontmatter = false;
    let mut frontmatter_complete = false;
    let mut skill_key = String::from(skill_id);
    let mut title = String::from(skill_id);
    let mut description = None;

    for line in markdown.lines() {
        let trimmed = line.trim();
        if trimmed == "---" {
            if !in_frontmatter && !frontmatter_complete {
                in_frontmatter = true;
                continue;
            }
            if in_frontmatter {
                in_frontmatter = false;
                frontmatter_complete = true;
                continue;
            }
        }

        if in_frontmatter {
            if let Some((key, value)) = trimmed.split_once(':') {
                let normalized_key = key.trim();
                let normalized_value = value.trim();
                if normalized_key == "name" && !normalized_value.is_empty() {
                    skill_key = String::from(normalized_value);
                    if title == skill_id {
                        title = String::from(normalized_value);
                    }
                }
                if normalized_key == "description"
                    && description.is_none()
                    && !normalized_value.is_empty()
                {
                    description = Some(String::from(normalized_value));
                }
            }
            continue;
        }

        if title == skill_id && trimmed.starts_with("# ") {
            let heading = trimmed.trim_start_matches("# ").trim();
            if !heading.is_empty() {
                title = String::from(heading);
            }
            continue;
        }

        if description.is_none() && !trimmed.is_empty() && !trimmed.starts_with('#') {
            description = Some(String::from(trimmed));
            break;
        }
    }

    (skill_key, title, description)
}

fn read_skill_enabled(config: &Value, skill_key: &str) -> bool {
    config
        .get("skills")
        .and_then(Value::as_object)
        .and_then(|skills| skills.get("entries"))
        .and_then(Value::as_object)
        .and_then(|entries| entries.get(skill_key))
        .and_then(Value::as_object)
        .and_then(|entry| entry.get("enabled"))
        .and_then(Value::as_bool)
        .unwrap_or(true)
}

fn set_skill_enabled_impl(app: &AppHandle, skill_key: &str, enabled: bool) -> Result<(), String> {
    let normalized_skill_key = skill_key.trim();
    if normalized_skill_key.is_empty() {
        return Err(String::from("skill key cannot be empty"));
    }

    let openclaw_home = resolve_openclaw_home_dir(app)?;
    let mut config = read_openclaw_config(&openclaw_home)?;
    let root = ensure_object(&mut config, "OpenClaw config root")?;
    let skills = root
        .entry(String::from("skills"))
        .or_insert_with(|| Value::Object(Map::new()));
    let skills_obj = skills
        .as_object_mut()
        .ok_or_else(|| String::from("skills config must be an object"))?;
    let entries = skills_obj
        .entry(String::from("entries"))
        .or_insert_with(|| Value::Object(Map::new()));
    let entries_obj = entries
        .as_object_mut()
        .ok_or_else(|| String::from("skills.entries config must be an object"))?;
    let skill_entry = entries_obj
        .entry(String::from(normalized_skill_key))
        .or_insert_with(|| Value::Object(Map::new()));
    let skill_entry_obj = skill_entry
        .as_object_mut()
        .ok_or_else(|| String::from("skill config entry must be an object"))?;

    if enabled {
        skill_entry_obj.remove("enabled");
    } else {
        skill_entry_obj.insert(String::from("enabled"), Value::Bool(false));
    }

    write_openclaw_config(&openclaw_home, &config)
}

fn install_skill_from_catalog_impl(app: &AppHandle, slug: &str) -> Result<(), String> {
    let normalized_slug = slug.trim();
    if normalized_slug.is_empty() {
        return Err(String::from("skill slug cannot be empty"));
    }
    let _ = append_launcher_log(
        app,
        "INFO",
        &format!("install_skill_from_catalog started slug={normalized_slug}"),
    );

    let openclaw_home = resolve_openclaw_home_dir(app)?;
    let workspace_skills_dir = openclaw_home
        .join(".openclaw")
        .join("workspace")
        .join("skills");
    fs::create_dir_all(&workspace_skills_dir).map_err(|error| {
        format!(
            "failed to create workspace skills directory {}: {error}",
            workspace_skills_dir.display()
        )
    })?;

    let download_url = SKILL_DOWNLOAD_URL_TEMPLATE.replace("{slug}", normalized_slug);
    let client = Client::builder()
        .build()
        .map_err(|error| format!("failed to initialize download client: {error}"))?;
    let response = client
        .get(&download_url)
        .send()
        .map_err(|error| format!("failed to download skill archive: {error}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "failed to download skill archive: HTTP {}",
            response.status()
        ));
    }

    let archive_bytes = response
        .bytes()
        .map_err(|error| format!("failed to read skill archive response: {error}"))?;

    extract_skill_archive(
        archive_bytes.as_ref(),
        &workspace_skills_dir,
        normalized_slug,
    )?;
    let _ = append_launcher_log(
        app,
        "INFO",
        &format!("install_skill_from_catalog succeeded slug={normalized_slug}"),
    );
    Ok(())
}

fn extract_skill_archive(
    archive_bytes: &[u8],
    workspace_skills_dir: &Path,
    slug: &str,
) -> Result<(), String> {
    let cursor = std::io::Cursor::new(archive_bytes);
    let mut archive =
        ZipArchive::new(cursor).map_err(|error| format!("failed to open zip archive: {error}"))?;
    let target_root = workspace_skills_dir.join(slug);
    let shared_root = detect_shared_archive_root(&mut archive);

    if target_root.exists() {
        fs::remove_dir_all(&target_root).map_err(|error| {
            format!(
                "failed to replace existing skill directory {}: {error}",
                target_root.display()
            )
        })?;
    }
    fs::create_dir_all(&target_root).map_err(|error| {
        format!(
            "failed to create skill target directory {}: {error}",
            target_root.display()
        )
    })?;

    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("failed to inspect zip entry: {error}"))?;
        let Some(entry_path) = entry.enclosed_name().map(PathBuf::from) else {
            continue;
        };

        let relative_path = normalize_archive_entry_path(&entry_path, shared_root.as_deref());
        if relative_path.as_os_str().is_empty() {
            continue;
        }

        let output_path = target_root.join(&relative_path);
        if entry.is_dir() {
            fs::create_dir_all(&output_path).map_err(|error| {
                format!(
                    "failed to create extracted directory {}: {error}",
                    output_path.display()
                )
            })?;
            continue;
        }

        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                format!(
                    "failed to create extracted parent directory {}: {error}",
                    parent.display()
                )
            })?;
        }

        let mut output_file = fs::File::create(&output_path).map_err(|error| {
            format!(
                "failed to create extracted file {}: {error}",
                output_path.display()
            )
        })?;
        std::io::copy(&mut entry, &mut output_file).map_err(|error| {
            format!(
                "failed to write extracted file {}: {error}",
                output_path.display()
            )
        })?;
    }

    let skill_file = target_root.join("SKILL.md");
    if !skill_file.exists() {
        return Err(format!(
            "downloaded archive for `{slug}` does not contain a valid SKILL.md"
        ));
    }

    Ok(())
}

fn detect_shared_archive_root<R: Read + std::io::Seek>(
    archive: &mut ZipArchive<R>,
) -> Option<PathBuf> {
    let mut shared_root = None::<PathBuf>;

    for index in 0..archive.len() {
        let Ok(entry) = archive.by_index(index) else {
            return None;
        };
        let Some(path) = entry.enclosed_name() else {
            continue;
        };

        let mut components = path.components();
        let Some(first) = components.next() else {
            continue;
        };
        let first_component = PathBuf::from(first.as_os_str());
        if components.next().is_none() {
            return None;
        }

        match &shared_root {
            None => shared_root = Some(first_component),
            Some(existing) if existing == &first_component => {}
            Some(_) => return None,
        }
    }

    shared_root
}

fn normalize_archive_entry_path(path: &Path, shared_root: Option<&Path>) -> PathBuf {
    if let Some(root) = shared_root {
        if let Ok(stripped) = path.strip_prefix(root) {
            return stripped.to_path_buf();
        }
    }
    path.to_path_buf()
}

fn remove_workspace_skill_impl(app: &AppHandle, slug: &str) -> Result<(), String> {
    let normalized_slug = slug.trim();
    if normalized_slug.is_empty() {
        return Err(String::from("skill slug cannot be empty"));
    }

    let openclaw_home = resolve_openclaw_home_dir(app)?;
    let skill_dir = openclaw_home
        .join(".openclaw")
        .join("workspace")
        .join("skills")
        .join(normalized_slug);

    if !skill_dir.exists() {
        return Err(format!(
            "workspace skill `{normalized_slug}` does not exist"
        ));
    }

    fs::remove_dir_all(&skill_dir).map_err(|error| {
        format!(
            "failed to remove workspace skill directory {}: {error}",
            skill_dir.display()
        )
    })?;
    let _ = append_launcher_log(
        app,
        "INFO",
        &format!("remove_workspace_skill succeeded slug={normalized_slug}"),
    );
    Ok(())
}

fn set_openclaw_primary_model_impl(app: &AppHandle, model: &str) -> Result<(), String> {
    let normalized_model = model.trim();
    if normalized_model.is_empty() {
        return Err(String::from("model cannot be empty"));
    }
    run_openclaw_command(app, &["models", "set", normalized_model])?;
    let _ = append_launcher_log(
        app,
        "INFO",
        &format!("set_openclaw_primary_model model={normalized_model}"),
    );
    Ok(())
}

fn save_local_model_selection_impl(app: &AppHandle, model: &str) -> Result<(), String> {
    let normalized_model = normalize_and_validate_ollama_model_name(model)?;
    let _ = append_launcher_log(
        app,
        "INFO",
        &format!("save_local_model_selection started model={normalized_model}"),
    );

    let preferences = read_launcher_preferences_impl(app)?;
    if !preferences.has_saved_preferences {
        return Err(String::from(
            "Launcher preferences are not configured yet. Choose a language and install directory first.",
        ));
    }

    let engine_dir = resolve_engine_dir(app)?;
    let openclaw_home = initialize_openclaw_home(app, &engine_dir)?;
    let mut config = read_openclaw_config(&openclaw_home)?;
    let root = ensure_object(&mut config, "OpenClaw config root")?;

    apply_initial_ollama_model_config(root, normalized_model);
    write_openclaw_config(&openclaw_home, &config)?;
    sanitize_openclaw_config(&openclaw_home)?;

    let model_ref = format!("ollama/{normalized_model}");
    set_openclaw_primary_model_impl(app, &model_ref)?;
    let _ = append_launcher_log(
        app,
        "INFO",
        &format!("save_local_model_selection succeeded model_ref={model_ref}"),
    );
    Ok(())
}

fn collect_selected_model_refs(config: &Value) -> Vec<String> {
    let mut refs = Vec::new();
    let mut push_ref = |raw: &str| {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return;
        }
        if refs.iter().any(|existing: &String| existing == trimmed) {
            return;
        }
        refs.push(String::from(trimmed));
    };

    if let Some(primary) = string_at_path(config, &["agents", "defaults", "model", "primary"]) {
        push_ref(&primary);
    }
    if let Some(fallbacks) = config
        .get("agents")
        .and_then(|value| value.get("defaults"))
        .and_then(|value| value.get("model"))
        .and_then(|value| value.get("fallbacks"))
        .and_then(Value::as_array)
    {
        for value in fallbacks.iter().filter_map(Value::as_str) {
            push_ref(value);
        }
    }
    if let Some(primary) = string_at_path(config, &["agents", "defaults", "imageModel", "primary"])
    {
        push_ref(&primary);
    }
    if let Some(fallbacks) = config
        .get("agents")
        .and_then(|value| value.get("defaults"))
        .and_then(|value| value.get("imageModel"))
        .and_then(|value| value.get("fallbacks"))
        .and_then(Value::as_array)
    {
        for value in fallbacks.iter().filter_map(Value::as_str) {
            push_ref(value);
        }
    }
    if let Some(configured_models) = config
        .get("agents")
        .and_then(|value| value.get("defaults"))
        .and_then(|value| value.get("models"))
        .and_then(Value::as_object)
    {
        for key in configured_models.keys() {
            push_ref(key);
        }
    }

    refs
}

fn cleanup_channel_residues(app: &AppHandle, channel: &str) -> Result<(), String> {
    let openclaw_home = resolve_openclaw_home_dir(app)?;
    let mut config = read_openclaw_config(&openclaw_home)?;
    let root = ensure_object(&mut config, "OpenClaw config root")?;

    if let Some(channels) = root.get_mut("channels").and_then(Value::as_object_mut) {
        channels.remove(channel);
    }

    let mut removed_install_paths = Vec::new();
    if let Some(plugins) = root.get_mut("plugins").and_then(Value::as_object_mut) {
        if let Some(entries) = plugins.get_mut("entries").and_then(Value::as_object_mut) {
            entries.retain(|plugin_id, _| !matches_channel_plugin_id(plugin_id, channel));
        }

        if let Some(installs) = plugins.get_mut("installs").and_then(Value::as_object_mut) {
            let matching_install_ids = installs
                .iter()
                .filter_map(|(plugin_id, value)| {
                    if !matches_channel_plugin_id(plugin_id, channel) {
                        return None;
                    }

                    let install_path = value
                        .get("installPath")
                        .and_then(Value::as_str)
                        .map(String::from);
                    Some((plugin_id.clone(), install_path))
                })
                .collect::<Vec<_>>();

            for (plugin_id, install_path) in matching_install_ids {
                installs.remove(&plugin_id);
                if let Some(path) = install_path {
                    removed_install_paths.push(PathBuf::from(path));
                }
            }
        }
    }

    write_openclaw_config(&openclaw_home, &config)?;

    let extensions_dir = openclaw_home.join("extensions");
    if extensions_dir.exists() {
        let entries = fs::read_dir(&extensions_dir)
            .map_err(|error| format!("failed to read extensions directory: {error}"))?;

        for entry in entries {
            let entry =
                entry.map_err(|error| format!("failed to inspect extension entry: {error}"))?;
            let path = entry.path();
            let Some(name) = path.file_name().and_then(OsStr::to_str) else {
                continue;
            };

            if matches_channel_plugin_id(name, channel) && path.exists() {
                fs::remove_dir_all(&path).map_err(|error| {
                    format!(
                        "failed to remove extension directory {}: {error}",
                        path.display()
                    )
                })?;
            }
        }
    }

    for install_path in removed_install_paths {
        if install_path.exists() {
            fs::remove_dir_all(&install_path).map_err(|error| {
                format!(
                    "failed to remove installed plugin directory {}: {error}",
                    install_path.display()
                )
            })?;
        }
    }

    let still_present = list_channel_accounts_impl(app)?
        .iter()
        .any(|entry| entry.channel == channel);
    if still_present {
        return Err(format!(
            "channel `{channel}` still appears after cleanup; residual plugin state remains"
        ));
    }

    Ok(())
}

fn apply_initial_ollama_model_config(root: &mut Map<String, Value>, model: &str) {
    let model_ref = format!("ollama/{model}");

    let agents = root
        .entry(String::from("agents"))
        .or_insert_with(|| Value::Object(Map::new()));
    let Some(agents_obj) = agents.as_object_mut() else {
        return;
    };
    let defaults = agents_obj
        .entry(String::from("defaults"))
        .or_insert_with(|| Value::Object(Map::new()));
    let Some(defaults_obj) = defaults.as_object_mut() else {
        return;
    };

    let models_aliases = defaults_obj
        .entry(String::from("models"))
        .or_insert_with(|| Value::Object(Map::new()));
    if let Some(models_aliases_obj) = models_aliases.as_object_mut() {
        let model_alias = models_aliases_obj
            .entry(model_ref.clone())
            .or_insert_with(|| Value::Object(Map::new()));
        if let Some(model_alias_obj) = model_alias.as_object_mut() {
            model_alias_obj.insert(String::from("alias"), Value::String(String::from(model)));
        }
    }

    let model_config = defaults_obj
        .entry(String::from("model"))
        .or_insert_with(|| Value::Object(Map::new()));
    if let Some(model_config_obj) = model_config.as_object_mut() {
        model_config_obj.insert(String::from("primary"), Value::String(model_ref));
    }

    let models = root
        .entry(String::from("models"))
        .or_insert_with(|| Value::Object(Map::new()));
    let Some(models_obj) = models.as_object_mut() else {
        return;
    };
    models_obj.insert(String::from("mode"), Value::String(String::from("merge")));

    let providers = models_obj
        .entry(String::from("providers"))
        .or_insert_with(|| Value::Object(Map::new()));
    let Some(providers_obj) = providers.as_object_mut() else {
        return;
    };

    let ollama = providers_obj
        .entry(String::from("ollama"))
        .or_insert_with(|| Value::Object(Map::new()));
    let Some(ollama_obj) = ollama.as_object_mut() else {
        return;
    };

    ollama_obj.insert(
        String::from("baseUrl"),
        Value::String(String::from("http://127.0.0.1:11434")),
    );
    ollama_obj.insert(String::from("api"), Value::String(String::from("ollama")));

    let model_definition = serde_json::json!({
        "id": model,
        "name": model,
        "reasoning": false,
        "input": ["text"],
        "contextWindow": 128000,
        "maxTokens": 4096,
        "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
    });

    match ollama_obj.get_mut("models") {
        Some(Value::Array(models)) => {
            let exists = models
                .iter()
                .any(|entry| entry.get("id").and_then(Value::as_str) == Some(model));
            if !exists {
                models.push(model_definition);
            }
        }
        _ => {
            ollama_obj.insert(String::from("models"), Value::Array(vec![model_definition]));
        }
    }
}

fn ensure_qq_plugin_ready(app: &AppHandle, engine_dir: &Path) -> Result<Option<String>, String> {
    let bundled_plugin_dir = engine_dir
        .join("openclaw")
        .join("node_modules")
        .join("openclaw-cn")
        .join("extensions")
        .join("qqbot");
    let bundled_entry = bundled_plugin_dir.join("index.ts");
    let bundled_node_modules = bundled_plugin_dir.join("node_modules");

    if bundled_entry.exists() && bundled_node_modules.exists() {
        return Ok(Some(bundled_plugin_dir.display().to_string()));
    }

    let installed_plugin_dir = resolve_openclaw_home_dir(app)?
        .join("extensions")
        .join("qqbot");
    if installed_plugin_dir.exists() {
        return Ok(None);
    }

    if let Err(error) = run_openclaw_command(app, &["plugins", "install", "@sliverp/qqbot"]) {
        if error.contains("插件已存在") || error.contains("already exists") {
            return Ok(None);
        }
        return Err(error);
    }

    Ok(None)
}

fn apply_initial_qq_channel_config(
    root: &mut Map<String, Value>,
    app_id: &str,
    app_secret: &str,
    qq_plugin_path: Option<&str>,
) -> Result<(), String> {
    let channels = root
        .entry(String::from("channels"))
        .or_insert_with(|| Value::Object(Map::new()));
    if let Some(channels_obj) = channels.as_object_mut() {
        let qqbot = channels_obj
            .entry(String::from("qqbot"))
            .or_insert_with(|| Value::Object(Map::new()));
        if let Some(qqbot_obj) = qqbot.as_object_mut() {
            qqbot_obj.insert(String::from("enabled"), Value::Bool(true));
            qqbot_obj.insert(String::from("appId"), Value::String(String::from(app_id)));
            qqbot_obj.insert(
                String::from("clientSecret"),
                Value::String(String::from(app_secret)),
            );
            qqbot_obj.insert(
                String::from("dmPolicy"),
                Value::String(String::from("pairing")),
            );
        }
    }

    let plugins = root
        .entry(String::from("plugins"))
        .or_insert_with(|| Value::Object(Map::new()));
    let Some(plugins_obj) = plugins.as_object_mut() else {
        return Ok(());
    };

    let entries = plugins_obj
        .entry(String::from("entries"))
        .or_insert_with(|| Value::Object(Map::new()));
    if let Some(entries_obj) = entries.as_object_mut() {
        let qqbot_entry = entries_obj
            .entry(String::from("qqbot"))
            .or_insert_with(|| Value::Object(Map::new()));
        if let Some(qqbot_entry_obj) = qqbot_entry.as_object_mut() {
            qqbot_entry_obj.insert(String::from("enabled"), Value::Bool(true));
        }
    }

    if let Some(load) = plugins_obj
        .entry(String::from("load"))
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
    {
        if let Some(paths) = load
            .entry(String::from("paths"))
            .or_insert_with(|| Value::Array(Vec::new()))
            .as_array_mut()
        {
            let bundled_marker =
                "/whereclaw-engine/openclaw/node_modules/openclaw-cn/extensions/qqbot";
            let installed_marker = "/openclaw-home/extensions/qqbot";
            let selected_path = qq_plugin_path.unwrap_or_default();

            paths.retain(|entry| {
                let Some(path) = entry.as_str() else {
                    return true;
                };
                if path.contains(bundled_marker) && selected_path != path {
                    return false;
                }
                if path.contains(installed_marker) && !selected_path.is_empty() {
                    return false;
                }
                true
            });

            if let Some(path) = qq_plugin_path {
                let exists = paths
                    .iter()
                    .any(|entry| entry.as_str().is_some_and(|value| value == path));
                if !exists {
                    paths.push(Value::String(String::from(path)));
                }
            }
        }
    }

    Ok(())
}

fn matches_channel_plugin_id(plugin_id: &str, channel: &str) -> bool {
    plugin_id == channel
        || plugin_id
            .strip_prefix(channel)
            .is_some_and(|suffix| suffix.starts_with('-'))
}

fn initialize_openclaw_home(app: &AppHandle, engine_dir: &Path) -> Result<PathBuf, String> {
    let openclaw_home = resolve_openclaw_home_dir(app)?;
    fs::create_dir_all(openclaw_home.join("workspace"))
        .map_err(|error| format!("failed to create OpenClaw workspace: {error}"))?;
    fs::create_dir_all(openclaw_home.join("logs"))
        .map_err(|error| format!("failed to create OpenClaw logs directory: {error}"))?;
    fs::create_dir_all(openclaw_home.join("data"))
        .map_err(|error| format!("failed to create OpenClaw data directory: {error}"))?;
    fs::create_dir_all(resolve_npm_cache_dir(&openclaw_home))
        .map_err(|error| format!("failed to create bundled npm cache directory: {error}"))?;
    fs::create_dir_all(resolve_npm_prefix_dir(&openclaw_home))
        .map_err(|error| format!("failed to create bundled npm prefix directory: {error}"))?;
    fs::create_dir_all(resolve_corepack_home_dir(&openclaw_home))
        .map_err(|error| format!("failed to create bundled corepack directory: {error}"))?;

    let target_config = openclaw_home.join("openclaw.json");
    if !target_config.exists() {
        let template_config = engine_dir.join("templates").join("openclaw.json");
        if template_config.exists() {
            fs::copy(&template_config, &target_config)
                .map_err(|error| format!("failed to copy OpenClaw config template: {error}"))?;
        }
    }

    if !target_config.exists() {
        fs::write(&target_config, "{}\n")
            .map_err(|error| format!("failed to create OpenClaw config: {error}"))?;
    }

    sanitize_openclaw_config(&openclaw_home)?;

    Ok(openclaw_home)
}

fn resolve_npm_cache_dir(openclaw_home: &Path) -> PathBuf {
    openclaw_home.join("data").join("npm-cache")
}

fn resolve_npm_prefix_dir(openclaw_home: &Path) -> PathBuf {
    openclaw_home.join("data").join("npm-prefix")
}

fn resolve_corepack_home_dir(openclaw_home: &Path) -> PathBuf {
    openclaw_home.join("data").join("corepack")
}

fn normalize_launcher_language(language: &str) -> Result<&'static str, String> {
    match language {
        "en" => Ok("en"),
        "zh-CN" => Ok("zh-CN"),
        _ => Err(format!("unsupported launcher language: {language}")),
    }
}

fn normalize_install_dir(install_dir: &str) -> Result<PathBuf, String> {
    let trimmed = install_dir.trim();
    if trimmed.is_empty() {
        return Err(String::from("install directory cannot be empty"));
    }

    let path = PathBuf::from(trimmed);
    let absolute = if path.is_absolute() {
        path
    } else {
        env::current_dir()
            .map_err(|error| format!("failed to resolve current working directory: {error}"))?
            .join(path)
    };

    Ok(absolute)
}

fn npm_registry_for_language(language: &str) -> Option<&'static str> {
    match language {
        "zh-CN" => Some(ZH_NPM_REGISTRY),
        _ => None,
    }
}

#[cfg(target_os = "macos")]
fn npm_registry_shell_exports(language: &str) -> String {
    npm_registry_for_language(language)
        .map(|registry| {
            let quoted = shell_single_quote(registry);
            format!(
                "export NPM_CONFIG_REGISTRY={quoted}\nexport npm_config_registry={quoted}\nexport COREPACK_NPM_REGISTRY={quoted}\n"
            )
        })
        .unwrap_or_default()
}

#[cfg(target_os = "windows")]
fn npm_registry_cmd_exports(language: &str) -> String {
    npm_registry_for_language(language)
        .map(|registry| {
            let escaped = cmd_escape(registry);
            format!(
                "set NPM_CONFIG_REGISTRY={escaped}\r\nset npm_config_registry={escaped}\r\nset COREPACK_NPM_REGISTRY={escaped}\r\n"
            )
        })
        .unwrap_or_default()
}

fn apply_registry_env(command: &mut Command, language: &str) {
    if let Some(registry) = npm_registry_for_language(language) {
        command
            .env("NPM_CONFIG_REGISTRY", registry)
            .env("npm_config_registry", registry)
            .env("COREPACK_NPM_REGISTRY", registry);
    }
}

fn apply_registry_env_to_pty_command(command: &mut CommandBuilder, language: &str) {
    if let Some(registry) = npm_registry_for_language(language) {
        command.env("NPM_CONFIG_REGISTRY", registry);
        command.env("npm_config_registry", registry);
        command.env("COREPACK_NPM_REGISTRY", registry);
    }
}

fn run_openclaw_command(app: &AppHandle, openclaw_args: &[&str]) -> Result<String, String> {
    let launcher_preferences = read_launcher_preferences_impl(app)?;
    if !launcher_preferences.has_saved_preferences {
        return Err(String::from(
            "Launcher preferences are not configured yet. Choose a language and install directory first.",
        ));
    }

    let engine_dir = resolve_engine_dir(app)?;
    let node_binary = resolve_node_binary(&engine_dir)?;
    let runtime_bin_dir = resolve_runtime_bin_dir(&engine_dir)?;
    let entry_script = resolve_openclaw_entry(&engine_dir)?;
    let openclaw_package_root = resolve_openclaw_package_root(&entry_script)?;
    let openclaw_home = initialize_openclaw_home(app, &engine_dir)?;
    let tmp_dir = initialize_openclaw_tmp_dir(&openclaw_home)?;
    let npm_cache_dir = resolve_npm_cache_dir(&openclaw_home);
    let npm_prefix_dir = resolve_npm_prefix_dir(&openclaw_home);
    let corepack_home_dir = resolve_corepack_home_dir(&openclaw_home);

    let mut command = Command::new(&node_binary);
    command
        .current_dir(&openclaw_package_root)
        .arg(&entry_script)
        .args(openclaw_args)
        .env("OPENCLAW_HOME", &openclaw_home)
        .env("OPENCLAW_STATE_DIR", &openclaw_home)
        .env("OPENCLAW_CONFIG_PATH", openclaw_home.join("openclaw.json"))
        .env("TMPDIR", &tmp_dir)
        .env("NPM_CONFIG_CACHE", &npm_cache_dir)
        .env("npm_config_cache", &npm_cache_dir)
        .env("NPM_CONFIG_PREFIX", &npm_prefix_dir)
        .env("npm_config_prefix", &npm_prefix_dir)
        .env("COREPACK_HOME", &corepack_home_dir);
    apply_registry_env(&mut command, &launcher_preferences.language);
    prepend_path_env(&mut command, &runtime_bin_dir)?;

    let output = command
        .output()
        .map_err(|error| format!("failed to run official OpenClaw command: {error}"))?;

    if output.status.success() {
        return String::from_utf8(output.stdout)
            .map_err(|error| format!("official OpenClaw command emitted invalid UTF-8: {error}"));
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !stderr.is_empty() {
        Err(stderr)
    } else if !stdout.is_empty() {
        Err(stdout)
    } else {
        Err(format!(
            "official OpenClaw command exited with status {}",
            output.status
        ))
    }
}

fn run_openclaw_json_command(app: &AppHandle, openclaw_args: &[&str]) -> Result<Value, String> {
    let stdout = run_openclaw_command(app, openclaw_args)?;
    parse_json_from_mixed_output(&stdout)
        .map_err(|error| format!("failed to parse official OpenClaw JSON output: {error}"))
}

fn parse_json_from_mixed_output(output: &str) -> Result<Value, String> {
    if let Ok(value) = serde_json::from_str::<Value>(output) {
        return Ok(value);
    }

    let bytes = output.as_bytes();
    for (index, byte) in bytes.iter().enumerate() {
        if *byte != b'{' && *byte != b'[' {
            continue;
        }

        if let Ok(value) = serde_json::from_str::<Value>(&output[index..]) {
            return Ok(value);
        }
    }

    Err(String::from("no valid JSON object found in command output"))
}

fn prepend_path_env(command: &mut Command, runtime_bin_dir: &Path) -> Result<(), String> {
    let existing_path = env::var_os("PATH");
    let mut path_entries = vec![runtime_bin_dir.to_path_buf()];
    if let Some(existing_path) = existing_path {
        path_entries.extend(env::split_paths(&existing_path));
    }
    let joined_path: OsString = env::join_paths(path_entries)
        .map_err(|error| format!("failed to construct PATH for bundled runtime: {error}"))?;
    command.env("PATH", joined_path);
    Ok(())
}

fn prepend_path_env_to_pty_command(
    command: &mut CommandBuilder,
    runtime_bin_dir: &Path,
) -> Result<(), String> {
    let existing_path = env::var_os("PATH");
    let mut path_entries = vec![runtime_bin_dir.to_path_buf()];
    if let Some(existing_path) = existing_path {
        path_entries.extend(env::split_paths(&existing_path));
    }
    let joined_path: OsString = env::join_paths(path_entries)
        .map_err(|error| format!("failed to construct PATH for bundled runtime: {error}"))?;
    command.env("PATH", joined_path);
    Ok(())
}

fn read_openclaw_config(openclaw_home: &Path) -> Result<Value, String> {
    let config_path = openclaw_home.join("openclaw.json");

    if !config_path.exists() {
        return Ok(Value::Object(Map::new()));
    }

    let config_text = fs::read_to_string(&config_path)
        .map_err(|error| format!("failed to read OpenClaw config: {error}"))?;

    if config_text.trim().is_empty() {
        return Ok(Value::Object(Map::new()));
    }

    serde_json::from_str(&config_text)
        .map_err(|error| format!("failed to parse OpenClaw config: {error}"))
}

fn write_openclaw_config(openclaw_home: &Path, config: &Value) -> Result<(), String> {
    let config_path = openclaw_home.join("openclaw.json");
    let updated = serde_json::to_string_pretty(config)
        .map_err(|error| format!("failed to serialize OpenClaw config: {error}"))?;
    fs::write(config_path, format!("{updated}\n"))
        .map_err(|error| format!("failed to update OpenClaw config: {error}"))
}

fn sanitize_openclaw_config(openclaw_home: &Path) -> Result<(), String> {
    let mut config = read_openclaw_config(openclaw_home)?;
    let root = ensure_object(&mut config, "OpenClaw config root")?;
    let mut changed = false;

    if let Some(commands) = root.get_mut("commands").and_then(Value::as_object_mut) {
        if commands.remove("ownerDisplay").is_some() {
            changed = true;
        }
    }

    if let Some(ollama) = root
        .get_mut("models")
        .and_then(Value::as_object_mut)
        .and_then(|models| models.get_mut("providers"))
        .and_then(Value::as_object_mut)
        .and_then(|providers| providers.get_mut("ollama"))
        .and_then(Value::as_object_mut)
    {
        let uses_ollama_api = ollama
            .get("api")
            .and_then(Value::as_str)
            .is_some_and(|value| value == "ollama");
        let missing_api_key = ollama
            .get("apiKey")
            .and_then(Value::as_str)
            .is_none_or(|value| value.trim().is_empty());

        if uses_ollama_api && missing_api_key {
            ollama.insert(
                String::from("apiKey"),
                Value::String(String::from("ollama-local")),
            );
            changed = true;
        }
    }

    if changed {
        write_openclaw_config(openclaw_home, &config)?;
    }

    Ok(())
}

fn initialize_openclaw_tmp_dir(openclaw_home: &Path) -> Result<PathBuf, String> {
    let tmp_dir = openclaw_home.join("tmp");
    fs::create_dir_all(&tmp_dir)
        .map_err(|error| format!("failed to create OpenClaw temp directory: {error}"))?;
    Ok(tmp_dir)
}

fn ensure_local_gateway_mode(openclaw_home: &Path) -> Result<(), String> {
    let mut config = read_openclaw_config(openclaw_home)?;
    let root = ensure_object(&mut config, "OpenClaw config root")?;
    let gateway = ensure_object_entry(root, "gateway")?;
    gateway.insert(String::from("mode"), Value::String(String::from("local")));
    let auth = ensure_object_entry(gateway, "auth")?;
    auth.insert(String::from("mode"), Value::String(String::from("token")));
    let token = auth
        .get("token")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(String::from)
        .unwrap_or_else(|| generate_local_gateway_token(openclaw_home));
    auth.insert(String::from("token"), Value::String(token));
    auth.remove("password");
    auth.remove("allowTailscale");
    write_openclaw_config(openclaw_home, &config)
}

fn generate_local_gateway_token(openclaw_home: &Path) -> String {
    let mut hasher = DefaultHasher::new();
    openclaw_home.display().to_string().hash(&mut hasher);
    std::process::id().hash(&mut hasher);
    if let Ok(now) = SystemTime::now().duration_since(UNIX_EPOCH) {
        now.as_nanos().hash(&mut hasher);
    }
    format!("whereclaw-{:016x}", hasher.finish())
}

fn ensure_object<'a>(
    value: &'a mut Value,
    context: &str,
) -> Result<&'a mut Map<String, Value>, String> {
    value
        .as_object_mut()
        .ok_or_else(|| format!("{context} is not a JSON object"))
}

fn ensure_object_entry<'a>(
    parent: &'a mut Map<String, Value>,
    key: &str,
) -> Result<&'a mut Map<String, Value>, String> {
    let entry = parent
        .entry(String::from(key))
        .or_insert_with(|| Value::Object(Map::new()));
    entry
        .as_object_mut()
        .ok_or_else(|| format!("OpenClaw config path `{key}` is not a JSON object"))
}

fn string_at_path(config: &Value, path: &[&str]) -> Option<String> {
    let mut current = config;
    for segment in path {
        current = current.get(*segment)?;
    }
    current.as_str().map(ToOwned::to_owned)
}

fn number_at_path(config: &Value, path: &[&str]) -> Option<u64> {
    let mut current = config;
    for segment in path {
        current = current.get(*segment)?;
    }
    current.as_u64()
}

fn is_configured(config: &Value) -> bool {
    string_at_path(config, &["agents", "defaults", "model", "primary"])
        .filter(|value| !value.trim().is_empty())
        .is_some()
}

fn copy_dir_recursive(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination).map_err(|error| {
        format!(
            "failed to create runtime directory {}: {error}",
            destination.display()
        )
    })?;

    let entries = fs::read_dir(source).map_err(|error| {
        format!(
            "failed to read bundled runtime directory {}: {error}",
            source.display()
        )
    })?;

    for entry in entries {
        let entry =
            entry.map_err(|error| format!("failed to inspect bundled runtime entry: {error}"))?;
        let source_path = entry.path();
        let target_path = destination.join(entry.file_name());
        let file_type = entry
            .file_type()
            .map_err(|error| format!("failed to inspect bundled runtime entry type: {error}"))?;

        if file_type.is_dir() {
            copy_dir_recursive(&source_path, &target_path)?;
        } else {
            if let Some(parent) = target_path.parent() {
                fs::create_dir_all(parent).map_err(|error| {
                    format!(
                        "failed to create parent directory {}: {error}",
                        parent.display()
                    )
                })?;
            }
            fs::copy(&source_path, &target_path).map_err(|error| {
                format!(
                    "failed to copy bundled runtime file {} to {}: {error}",
                    source_path.display(),
                    target_path.display()
                )
            })?;
        }
    }

    Ok(())
}

#[cfg(target_os = "macos")]
fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(target_os = "windows")]
fn cmd_escape(value: &str) -> String {
    value.replace('^', "^^")
}

#[cfg(target_os = "windows")]
fn node_binary_name() -> &'static str {
    "node.exe"
}

#[cfg(target_os = "macos")]
fn node_binary_name() -> &'static str {
    "node"
}

#[cfg(target_os = "linux")]
fn node_binary_name() -> &'static str {
    "node"
}

#[cfg(target_os = "windows")]
fn ollama_binary_name() -> &'static str {
    "ollama.exe"
}

#[cfg(target_os = "macos")]
fn ollama_binary_name() -> &'static str {
    "ollama"
}

#[cfg(target_os = "linux")]
fn ollama_binary_name() -> &'static str {
    "ollama"
}

#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
fn ollama_platform_dir_name() -> &'static str {
    "windows-x64"
}

#[cfg(all(target_os = "windows", target_arch = "aarch64"))]
fn ollama_platform_dir_name() -> &'static str {
    "windows-arm64"
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn ollama_platform_dir_name() -> &'static str {
    "darwin-arm64"
}

#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
fn ollama_platform_dir_name() -> &'static str {
    "darwin-x64"
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
fn ollama_platform_dir_name() -> &'static str {
    "linux-x64"
}

#[cfg(all(target_os = "linux", target_arch = "aarch64"))]
fn ollama_platform_dir_name() -> &'static str {
    "linux-arm64"
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(GatewayState {
            child: Arc::new(Mutex::new(None)),
            current_port: Arc::new(Mutex::new(CONTROL_UI_PORT)),
        })
        .manage(OllamaState {
            child: Arc::new(Mutex::new(None)),
        })
        .manage(LocalModelRunState {
            progress: Arc::new(Mutex::new(LocalModelRunProgress::default())),
            pull_pid: Arc::new(Mutex::new(None)),
            stop_requested: Arc::new(Mutex::new(false)),
        })
        .manage(ExitIntentState {
            quitting: AtomicBool::new(false),
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }

            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let quitting = window
                    .app_handle()
                    .try_state::<ExitIntentState>()
                    .map(|state| state.quitting.load(Ordering::SeqCst))
                    .unwrap_or(false);

                if !quitting {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            app.handle().plugin(tauri_plugin_dialog::init())?;
            install_tray(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_gateway,
            stop_gateway,
            gateway_status,
            start_ollama,
            stop_ollama,
            ollama_status,
            pull_ollama_model,
            list_ollama_models,
            check_local_model_exists,
            start_local_model_run,
            stop_local_model_run,
            get_local_model_run_progress,
            open_official_setup_wizard,
            open_channel_add_wizard,
            open_model_provider_add_wizard,
            open_model_add_wizard,
            read_setup_info,
            read_launcher_preferences,
            ensure_remote_skill_catalog_fresh,
            read_active_skill_catalog,
            read_remote_notifications,
            read_remote_desktop_version,
            save_launcher_preferences,
            reset_launcher_state,
            reset_openclaw_config,
            apply_initial_setup_config,
            list_channel_accounts,
            remove_channel_account,
            read_launcher_logs,
            append_frontend_log,
            list_openclaw_models,
            list_installed_skills,
            set_skill_enabled,
            install_skill_from_catalog,
            remove_workspace_skill,
            set_openclaw_primary_model,
            save_local_model_selection,
            open_control_ui_window,
            open_control_ui_in_browser,
            open_external_url,
            open_openclaw_config_file,
            open_whereclaw_terminal,
            get_system_memory_info
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app, event| {
        if matches!(event, tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit) {
            if let Err(error) = cleanup_processes_on_exit(app) {
                let _ = append_launcher_log(app, "WARN", &format!("exit cleanup failed: {error}"));
            }
        }
    });
}


#[cfg(test)]
mod tests {
    use super::{
        normalize_ollama_model_name_for_lookup,
        build_whereclaw_terminal_ollama_wrapper_script,
        build_whereclaw_terminal_shell_rc,
        build_whereclaw_terminal_windows_script,
        is_remote_desktop_version_newer,
        is_remote_version_newer,
        CachedSkillCatalogMetadata,
        OLLAMA_HOST,
    };

    #[test]
    fn semver_comparison_detects_newer_remote_skills_versions() {
        assert_eq!(is_remote_version_newer("1.0.2", "1.0.1"), Ok(true));
        assert_eq!(is_remote_version_newer("1.0.1", "1.0.1"), Ok(false));
        assert_eq!(is_remote_version_newer("1.0.0", "1.0.1"), Ok(false));
    }

    #[test]
    fn cached_skill_metadata_defaults_notifications_for_old_schema() {
        let metadata: CachedSkillCatalogMetadata = serde_json::from_str(
            r#"{"version":"1.0.2","url":"https://r2.tolearn.cc/skills.json"}"#,
        )
        .expect("old metadata schema should still parse");

        assert_eq!(metadata.desktop_version, None);
        assert!(metadata.notifications.cn.is_empty());
        assert!(metadata.notifications.en.is_empty());
    }

    #[test]
    fn desktop_update_detection_requires_newer_valid_semver() {
        assert!(is_remote_desktop_version_newer(Some("1.0.1"), "1.0.0"));
        assert!(!is_remote_desktop_version_newer(Some("1.0.0"), "1.0.0"));
        assert!(!is_remote_desktop_version_newer(Some(""), "1.0.0"));
        assert!(!is_remote_desktop_version_newer(None, "1.0.0"));
        assert!(!is_remote_desktop_version_newer(Some("latest"), "1.0.0"));
    }

    #[test]
    fn treats_bare_and_latest_ollama_model_names_as_equal_for_lookup() {
        assert_eq!(
            normalize_ollama_model_name_for_lookup("qwen3.5"),
            normalize_ollama_model_name_for_lookup("qwen3.5:latest")
        );
    }

    #[test]
    fn preserves_non_latest_tags_for_lookup() {
        assert_ne!(
            normalize_ollama_model_name_for_lookup("qwen3.5:0.8b"),
            normalize_ollama_model_name_for_lookup("qwen3.5:latest")
        );
    }

    #[test]
    fn whereclaw_terminal_shell_rc_exports_ollama_and_advertises_command() {
        let shell_rc = build_whereclaw_terminal_shell_rc(
            "/openclaw/home",
            "/openclaw/home/openclaw.json",
            "/openclaw/home/tmp",
            "/openclaw/home/data/npm-cache",
            "/openclaw/home/data/npm-prefix",
            "/openclaw/home/data/corepack",
            "/openclaw/home/tmp/terminal-bin",
            "/engine/node-runtime/bin",
            "/openclaw/package",
            "",
            "/openclaw/home/data/ollama-models",
        );

        assert!(shell_rc.contains("export OLLAMA_HOST='127.0.0.1:11434'"));
        assert!(shell_rc.contains("export OLLAMA_MODELS='/openclaw/home/data/ollama-models'"));
        assert!(shell_rc.contains("Bundled commands: node, npm, npx, openclaw, ollama"));
    }

    #[test]
    fn whereclaw_terminal_ollama_wrapper_targets_bundled_runtime() {
        let wrapper = build_whereclaw_terminal_ollama_wrapper_script(
            "/runtime/ollama",
            "/openclaw/home/data/ollama-models",
        );

        assert!(wrapper.contains("export OLLAMA_HOST='127.0.0.1:11434'"));
        assert!(wrapper.contains("export OLLAMA_MODELS='/openclaw/home/data/ollama-models'"));
        assert!(wrapper.contains("\"/runtime/ollama\" \"$@\""));
    }

    #[test]
    fn whereclaw_terminal_windows_script_sets_ollama_env_and_hint() {
        let script = build_whereclaw_terminal_windows_script(
            "C:/openclaw/home",
            "C:/openclaw/home/openclaw.json",
            "C:/openclaw/home/tmp",
            "C:/openclaw/home/data/npm-cache",
            "C:/openclaw/home/data/npm-prefix",
            "C:/openclaw/home/data/corepack",
            "C:/openclaw/home/tmp/terminal-bin",
            "C:/engine/node-runtime",
            "C:/openclaw/package",
            "",
            "C:/openclaw/home/data/ollama-models",
        );

        assert!(script.contains(&format!("set OLLAMA_HOST={}", OLLAMA_HOST)));
        assert!(script.contains("set OLLAMA_MODELS=C:/openclaw/home/data/ollama-models"));
        assert!(script.contains("Bundled commands: node, npm, npx, openclaw, ollama"));
    }
}
