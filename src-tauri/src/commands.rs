use std::fs;
use std::path::{Path, PathBuf};

use synapse_core::{build_tree, ensure_within, FileNode};

/// 전역 설정 디렉토리: ~/.config/synapse (OS별 표준 위치, FR-5.1)
fn config_dir() -> Result<PathBuf, String> {
    dirs::config_dir()
        .map(|d| d.join("synapse"))
        .ok_or_else(|| "cannot resolve OS config directory".to_string())
}

#[tauri::command]
pub fn list_workspace(app: tauri::AppHandle, path: String) -> Result<FileNode, String> {
    // 연 폴더만 asset protocol(로컬 이미지 등)로 접근 가능하게 런타임 스코프를 연다.
    // 설정 파일에 "**" 같은 광역 스코프를 두지 않기 위한 조치 (NFR-4).
    use tauri::Manager;
    let _ = app
        .asset_protocol_scope()
        .allow_directory(Path::new(&path), true);
    build_tree(Path::new(&path)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn read_file(root: String, path: String) -> Result<String, String> {
    let resolved =
        ensure_within(Path::new(&root), Path::new(&path)).map_err(|e| e.to_string())?;
    fs::read_to_string(resolved).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn write_file(root: String, path: String, content: String) -> Result<(), String> {
    let resolved = synapse_core::ensure_writable_within(Path::new(&root), Path::new(&path))
        .map_err(|e| e.to_string())?;
    synapse_core::atomic_write(&resolved, &content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_note(root: String, dir: String) -> Result<String, String> {
    let resolved =
        ensure_within(Path::new(&root), Path::new(&dir)).map_err(|e| e.to_string())?;
    let path = synapse_core::create_unique_note(&resolved).map_err(|e| e.to_string())?;
    Ok(path.display().to_string())
}

#[tauri::command]
pub fn recent_workspaces() -> Result<Vec<String>, String> {
    Ok(synapse_core::recent_workspaces(&config_dir()?))
}

#[tauri::command]
pub fn record_workspace_opened(path: String) -> Result<Vec<String>, String> {
    synapse_core::record_opened(&config_dir()?, Path::new(&path)).map_err(|e| e.to_string())
}

/// 뷰어용 HTML을 앱 캐시에 쓰고 asset protocol로 접근 가능하게 한다 (FR-3).
/// 사용자 폴더를 오염시키지 않기 위해 워크스페이스가 아닌 설정 캐시 디렉토리를 쓴다.
#[tauri::command]
pub fn viewer_cache_write(
    app: tauri::AppHandle,
    file_name: String,
    content: String,
) -> Result<String, String> {
    if file_name.contains('/') || file_name.contains('\\') || file_name.contains("..") {
        return Err("invalid cache file name".to_string());
    }
    let dir = config_dir()?.join("cache").join("viewer");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(file_name);
    synapse_core::atomic_write(&path, &content).map_err(|e| e.to_string())?;
    use tauri::Manager;
    let _ = app.asset_protocol_scope().allow_file(&path);
    Ok(path.display().to_string())
}

#[tauri::command]
pub fn get_last_workspace() -> Result<Option<String>, String> {
    Ok(synapse_core::registry::last_workspace(&config_dir()?))
}

#[tauri::command]
pub fn clear_last_workspace() -> Result<(), String> {
    synapse_core::registry::clear_last_workspace(&config_dir()?).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_workspace_state(path: String) -> Result<serde_json::Value, String> {
    Ok(synapse_core::registry::workspace_state(&config_dir()?, Path::new(&path)))
}

#[tauri::command]
pub fn set_workspace_state(path: String, state: serde_json::Value) -> Result<(), String> {
    synapse_core::registry::set_workspace_state(&config_dir()?, Path::new(&path), state)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_settings() -> Result<synapse_core::settings::Settings, String> {
    Ok(synapse_core::settings::load_settings(&config_dir()?))
}

#[tauri::command]
pub fn update_settings(settings: synapse_core::settings::Settings) -> Result<(), String> {
    synapse_core::settings::save_settings(&config_dir()?, &settings).map_err(|e| e.to_string())
}
