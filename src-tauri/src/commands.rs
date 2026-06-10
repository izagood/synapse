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
pub fn list_workspace(path: String) -> Result<FileNode, String> {
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
