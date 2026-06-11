use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

use synapse_core::{build_tree, ensure_within, FileNode};

/// 전역 설정 디렉토리: ~/.config/synapse (OS별 표준 위치, FR-5.1)
pub(crate) fn config_dir() -> Result<PathBuf, String> {
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

/// 마크다운 문서 저장 (FR-6): frontmatter의 `synapse_id`를 보장하고 base→content
/// 변경을 CRDT에 기록한 뒤, 합쳐진 최종 텍스트를 .md에 쓰고 돌려준다.
/// 그 사이 원격 머지나 외부 편집이 있었다면 돌려준 텍스트에 합쳐져 있다.
#[tauri::command]
pub async fn save_doc(
    root: String,
    path: String,
    content: String,
    base: String,
) -> Result<String, String> {
    // 디스크 I/O와 락 대기(동기화의 로컬 구간과 경합)를 메인 스레드 밖에서
    crate::sync::run_blocking(move || {
        use synapse_core::collab;

        let resolved = synapse_core::ensure_writable_within(Path::new(&root), Path::new(&path))
            .map_err(|e| e.to_string())?;
        let _guard = collab::workspace_lock()
            .lock()
            .map_err(|_| "workspace lock poisoned".to_string())?;
        let actor = collab::load_or_create_actor_id(&config_dir()?).map_err(|e| e.to_string())?;
        let store = synapse_core::CollabStore::new(Path::new(&root), actor);
        store
            .save_doc_file(&resolved, &content, &base)
            .map_err(|e| e.to_string())
    })
    .await
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

static WINDOW_SEQ: AtomicU32 = AtomicU32::new(1);

/// 새 앱 창 생성. folder가 있으면 그 폴더를 바로 열고, 없으면 시작 화면.
/// (⇧⌘N 커맨드와 macOS dock 메뉴가 공용으로 사용)
pub fn open_extra_window(app: &tauri::AppHandle, folder: Option<String>) -> Result<(), String> {
    let label = format!("synapse-{}", WINDOW_SEQ.fetch_add(1, Ordering::Relaxed));
    let script = match &folder {
        Some(path) => format!(
            "window.__SYNAPSE_FRESH_WINDOW__ = true; window.__SYNAPSE_OPEN_FOLDER__ = {};",
            serde_json::to_string(path).map_err(|e| e.to_string())?
        ),
        None => "window.__SYNAPSE_FRESH_WINDOW__ = true;".to_string(),
    };
    tauri::WebviewWindowBuilder::new(app, &label, tauri::WebviewUrl::App("index.html".into()))
        .title("Synapse")
        .inner_size(1280.0, 800.0)
        .min_inner_size(800.0, 500.0)
        // Tauri의 네이티브 드롭 가로채기를 끄고 HTML5 드래그앤드롭 사용
        // (메인 창의 dragDropEnabled: false와 동일해야 함)
        .disable_drag_drop_handler()
        .initialization_script(&script)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 새 앱 창을 띄운다 (여러 폴더를 동시에 보기, FR-1)
#[tauri::command]
pub fn new_window(app: tauri::AppHandle) -> Result<(), String> {
    open_extra_window(&app, None)
}

/// 이미지 바이트를 노트와 같은 폴더에 저장한다 (드래그앤드롭/붙여넣기, FR-2.7 변형)
/// 같은 이름이 있으면 "이름 2.ext"로 비켜 쓰고 최종 파일명을 돌려준다.
#[tauri::command]
pub fn save_image(
    root: String,
    dir: String,
    desired_name: String,
    data_base64: String,
) -> Result<String, String> {
    if desired_name.contains('/') || desired_name.contains('\\') || desired_name.contains("..") {
        return Err("invalid image file name".to_string());
    }
    let dir = ensure_within(Path::new(&root), Path::new(&dir)).map_err(|e| e.to_string())?;
    let bytes = synapse_core::fs_io::base64_decode(&data_base64)?;
    // md 링크 목적지에 공백이 못 들어가므로 충돌 회피 suffix도 "-"로
    synapse_core::fs_io::write_unique(&dir, &desired_name, &bytes, "-").map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rename_path(root: String, path: String, new_name: String) -> Result<String, String> {
    let resolved =
        ensure_within(Path::new(&root), Path::new(&path)).map_err(|e| e.to_string())?;
    if resolved == Path::new(&root) {
        return Err("워크스페이스 루트는 이름을 바꿀 수 없습니다".to_string());
    }
    synapse_core::fs_io::rename_entry(&resolved, &new_name)
        .map(|p| p.display().to_string())
        .map_err(|e| e.to_string())
}

/// 워크스페이스 전체 텍스트 검색 (FR-1.5). 디스크 순회가 메인 스레드를 막지
/// 않도록 스레드 풀에서 돈다.
#[tauri::command]
pub async fn search_workspace(
    root: String,
    query: String,
) -> Result<Vec<synapse_core::SearchHit>, String> {
    crate::sync::run_blocking(move || {
        let opts = synapse_core::SearchOptions::default();
        Ok(synapse_core::search_workspace(Path::new(&root), &query, &opts))
    })
    .await
}

#[tauri::command]
pub fn delete_path(root: String, path: String) -> Result<(), String> {
    let resolved =
        ensure_within(Path::new(&root), Path::new(&path)).map_err(|e| e.to_string())?;
    if resolved == Path::new(&root) {
        return Err("워크스페이스 루트는 삭제할 수 없습니다".to_string());
    }
    if resolved.is_dir() {
        fs::remove_dir_all(&resolved).map_err(|e| e.to_string())
    } else {
        fs::remove_file(&resolved).map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn duplicate_path(root: String, path: String) -> Result<String, String> {
    let resolved =
        ensure_within(Path::new(&root), Path::new(&path)).map_err(|e| e.to_string())?;
    synapse_core::fs_io::duplicate_file(&resolved).map_err(|e| e.to_string())
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
