use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

use synapse_core::{path_to_uri, urify_tree, Backend, Backlink, FileNode, LinkGraph, Location};

use crate::remote::{backend_for, fs_path, require_local, RemoteState};

/// 위치 문자열(로컬 경로 또는 ssh:// URI)을 [`Location`]으로 파싱한다.
fn parse_loc(s: &str) -> Result<Location, String> {
    Location::parse(s).map_err(|e| e.to_string())
}

/// 전역 설정 디렉토리: ~/.config/synapse (OS별 표준 위치, FR-5.1)
pub(crate) fn config_dir() -> Result<PathBuf, String> {
    dirs::config_dir()
        .map(|d| d.join("synapse"))
        .ok_or_else(|| "cannot resolve OS config directory".to_string())
}

#[tauri::command]
pub async fn list_workspace(
    app: tauri::AppHandle,
    state: tauri::State<'_, RemoteState>,
    path: String,
) -> Result<FileNode, String> {
    let loc = parse_loc(&path)?;
    // 로컬 폴더만 asset protocol(로컬 이미지 등)로 접근 가능하게 런타임 스코프를 연다.
    // 설정 파일에 "**" 같은 광역 스코프를 두지 않기 위한 조치 (NFR-4).
    if let Location::Local(p) = &loc {
        use tauri::Manager;
        let _ = app.asset_protocol_scope().allow_directory(p, true);
    }
    let backend = backend_for(&state, &loc)?;
    let root = fs_path(&loc);
    crate::sync::run_blocking(move || {
        let mut tree = backend.build_tree(&root).map_err(|e| e.to_string())?;
        // 원격 트리의 노드 경로를 프론트가 다시 열 수 있는 URI로 바꾼다(로컬은 무변경).
        urify_tree(&loc, &mut tree);
        Ok(tree)
    })
    .await
}

#[tauri::command]
pub async fn read_file(
    state: tauri::State<'_, RemoteState>,
    root: String,
    path: String,
) -> Result<String, String> {
    let root_loc = parse_loc(&root)?;
    let path_loc = parse_loc(&path)?;
    let backend = backend_for(&state, &root_loc)?;
    let root_path = fs_path(&root_loc);
    let cand = fs_path(&path_loc);
    crate::sync::run_blocking(move || {
        let resolved = backend
            .ensure_within(&root_path, &cand)
            .map_err(|e| e.to_string())?;
        backend.read_to_string(&resolved).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn write_file(
    state: tauri::State<'_, RemoteState>,
    root: String,
    path: String,
    content: String,
) -> Result<(), String> {
    let root_loc = parse_loc(&root)?;
    let path_loc = parse_loc(&path)?;
    let backend = backend_for(&state, &root_loc)?;
    let root_path = fs_path(&root_loc);
    let cand = fs_path(&path_loc);
    crate::sync::run_blocking(move || {
        let resolved = backend
            .ensure_writable_within(&root_path, &cand)
            .map_err(|e| e.to_string())?;
        backend
            .write_atomic(&resolved, content.as_bytes())
            .map_err(|e| e.to_string())
    })
    .await
}

/// 마크다운 문서 저장 (FR-6): frontmatter의 `synapse_id`를 보장하고 base→content
/// 변경을 CRDT에 기록한 뒤, 합쳐진 최종 텍스트를 .md에 쓰고 돌려준다.
/// 그 사이 원격 머지나 외부 편집이 있었다면 돌려준 텍스트에 합쳐져 있다.
#[tauri::command]
pub async fn save_doc(
    state: tauri::State<'_, RemoteState>,
    root: String,
    path: String,
    content: String,
    base: String,
) -> Result<String, String> {
    let root_loc = parse_loc(&root)?;
    let path_loc = parse_loc(&path)?;
    let backend = backend_for(&state, &root_loc)?;
    let root_path = fs_path(&root_loc);
    let cand = fs_path(&path_loc);
    // 디스크 I/O와 락 대기(동기화의 로컬 구간과 경합)를 메인 스레드 밖에서
    crate::sync::run_blocking(move || {
        use synapse_core::collab;

        let resolved = backend
            .ensure_writable_within(&root_path, &cand)
            .map_err(|e| e.to_string())?;
        let _guard = collab::workspace_lock()
            .lock()
            .map_err(|_| "workspace lock poisoned".to_string())?;
        // actor-id는 설치본 식별자라 원격 워크스페이스에서도 로컬 config에서 읽는다.
        let actor = collab::load_or_create_actor_id(&config_dir()?).map_err(|e| e.to_string())?;
        let store = synapse_core::CollabStore::new(backend, root_path, actor);
        store
            .save_doc_file(&resolved, &content, &base)
            .map_err(|e| e.to_string())
    })
    .await
}

/// AI 안전 편집 (2-B): 승인된 AI 편집을 사용자 로그와 분리된 `ai-assistant`
/// actor로 라우팅한다. 파일을 직접 덮어쓰지 않고 CollabStore를 경유시켜
/// `log-ai-assistant.y`에 기록 → CRDT가 사용자 편집과 자동 병합한다.
/// base_content는 AI가 본 기준 텍스트, new_content는 적용 후 전체 텍스트다.
#[tauri::command]
pub async fn agent_edit_file(
    state: tauri::State<'_, RemoteState>,
    root: String,
    path: String,
    new_content: String,
    base_content: String,
) -> Result<String, String> {
    let root_loc = parse_loc(&root)?;
    let path_loc = parse_loc(&path)?;
    let backend = backend_for(&state, &root_loc)?;
    let root_path = fs_path(&root_loc);
    let cand = fs_path(&path_loc);
    crate::sync::run_blocking(move || {
        use synapse_core::collab;

        // 새 파일(Write)도 만들 수 있어야 하므로 writable 가드를 쓴다 (루트 내부만)
        let resolved = backend
            .ensure_writable_within(&root_path, &cand)
            .map_err(|e| e.to_string())?;
        let _guard = collab::workspace_lock()
            .lock()
            .map_err(|_| "workspace lock poisoned".to_string())?;
        // 고정 actor "ai-assistant" — 사용자 actor와 별도 로그로 분리된다
        let store = synapse_core::CollabStore::new(backend, root_path, "ai-assistant".to_string());
        store
            .save_doc_file(&resolved, &new_content, &base_content)
            .map_err(|e| e.to_string())
    })
    .await
}

/// 현재 노트(path)를 가리키는 다른 노트들의 백링크를 모은다 (FR-2.8 → FR-6.1).
/// 워크스페이스 전체 순회가 무거울 수 있어 블로킹 풀에서 돈다.
#[tauri::command]
pub async fn backlinks(root: String, path: String) -> Result<Vec<Backlink>, String> {
    require_local(&parse_loc(&root)?)?;
    crate::sync::run_blocking(move || {
        synapse_core::backlinks_for(Path::new(&root), Path::new(&path)).map_err(|e| e.to_string())
    })
    .await
}

/// 워크스페이스 전체의 노트 링크 그래프(노드=노트, 엣지=링크)를 만든다 (FR-6.2).
/// 백링크와 같은 전체 순회라 무거울 수 있어 블로킹 풀에서 돈다.
#[tauri::command]
pub async fn link_graph(root: String) -> Result<LinkGraph, String> {
    require_local(&parse_loc(&root)?)?;
    crate::sync::run_blocking(move || {
        synapse_core::build_graph(Path::new(&root)).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn create_note(
    state: tauri::State<'_, RemoteState>,
    root: String,
    dir: String,
) -> Result<String, String> {
    let root_loc = parse_loc(&root)?;
    let dir_loc = parse_loc(&dir)?;
    let backend = backend_for(&state, &root_loc)?;
    let root_path = fs_path(&root_loc);
    let dir_path = fs_path(&dir_loc);
    crate::sync::run_blocking(move || {
        let resolved = backend
            .ensure_within(&root_path, &dir_path)
            .map_err(|e| e.to_string())?;
        let path = backend
            .create_unique_note(&resolved)
            .map_err(|e| e.to_string())?;
        Ok(path_to_uri(&root_loc, &path.to_string_lossy()))
    })
    .await
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
    if !synapse_core::is_safe_file_name(&file_name) {
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
pub async fn save_image(
    state: tauri::State<'_, RemoteState>,
    root: String,
    dir: String,
    desired_name: String,
    data_base64: String,
) -> Result<String, String> {
    if !synapse_core::is_safe_file_name(&desired_name) {
        return Err("invalid image file name".to_string());
    }
    let root_loc = parse_loc(&root)?;
    let dir_loc = parse_loc(&dir)?;
    let backend = backend_for(&state, &root_loc)?;
    let root_path = fs_path(&root_loc);
    let dir_path = fs_path(&dir_loc);
    let bytes = synapse_core::fs_io::base64_decode(&data_base64)?;
    crate::sync::run_blocking(move || {
        let dir = backend
            .ensure_within(&root_path, &dir_path)
            .map_err(|e| e.to_string())?;
        // md 링크 목적지에 공백이 못 들어가므로 충돌 회피 suffix도 "-"로
        backend
            .write_unique(&dir, &desired_name, &bytes, "-")
            .map_err(|e| e.to_string())
    })
    .await
}

/// 바이너리(base64) 바이트를 dir 에 새 파일로 쓴다. 같은 이름이 있으면 "이름 2.ext"로
/// 비켜 쓰고 최종 파일명을 돌려준다. PDF 굽기(주석 합성 사본 저장) 등에 쓴다.
#[tauri::command]
pub async fn write_binary_unique(
    state: tauri::State<'_, RemoteState>,
    root: String,
    dir: String,
    desired_name: String,
    data_base64: String,
) -> Result<String, String> {
    if !synapse_core::is_safe_file_name(&desired_name) {
        return Err("invalid file name".to_string());
    }
    let root_loc = parse_loc(&root)?;
    let dir_loc = parse_loc(&dir)?;
    let backend = backend_for(&state, &root_loc)?;
    let root_path = fs_path(&root_loc);
    let dir_path = fs_path(&dir_loc);
    let bytes = synapse_core::fs_io::base64_decode(&data_base64)?;
    crate::sync::run_blocking(move || {
        let dir = backend
            .ensure_within(&root_path, &dir_path)
            .map_err(|e| e.to_string())?;
        backend
            .write_unique(&dir, &desired_name, &bytes, " ")
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn rename_path(
    state: tauri::State<'_, RemoteState>,
    root: String,
    path: String,
    new_name: String,
) -> Result<String, String> {
    let root_loc = parse_loc(&root)?;
    let path_loc = parse_loc(&path)?;
    let backend = backend_for(&state, &root_loc)?;
    let root_path = fs_path(&root_loc);
    let cand = fs_path(&path_loc);
    crate::sync::run_blocking(move || {
        let resolved = backend
            .ensure_within(&root_path, &cand)
            .map_err(|e| e.to_string())?;
        if resolved == root_path {
            return Err("워크스페이스 루트는 이름을 바꿀 수 없습니다".to_string());
        }
        let renamed = backend
            .rename_entry(&resolved, &new_name)
            .map_err(|e| e.to_string())?;
        Ok(path_to_uri(&root_loc, &renamed.to_string_lossy()))
    })
    .await
}

/// 워크스페이스 전체 텍스트 검색 (FR-1.5). 디스크 순회가 메인 스레드를 막지
/// 않도록 스레드 풀에서 돈다.
#[tauri::command]
pub async fn search_workspace(
    root: String,
    query: String,
) -> Result<Vec<synapse_core::SearchHit>, String> {
    require_local(&parse_loc(&root)?)?;
    crate::sync::run_blocking(move || {
        let opts = synapse_core::SearchOptions::default();
        Ok(synapse_core::search_workspace(
            Path::new(&root),
            &query,
            &opts,
        ))
    })
    .await
}

/// "내 노트에게 묻기"용 retrieval (2-C): 질문에서 키워드를 뽑아 워크스페이스를
/// 검색하고 백링크로 인접 노트를 보강해 근거 스니펫을 모은다. 워크스페이스 전체를
/// 순회하므로 검색과 동일하게 스레드 풀에서 돈다(읽기 전용).
#[tauri::command]
pub async fn retrieve_notes(
    root: String,
    question: String,
) -> Result<synapse_core::RetrievalResult, String> {
    require_local(&parse_loc(&root)?)?;
    crate::sync::run_blocking(move || {
        let opts = synapse_core::RetrievalOptions::default();
        Ok(synapse_core::retrieve_context(
            Path::new(&root),
            &question,
            &opts,
        ))
    })
    .await
}

#[tauri::command]
pub async fn delete_path(
    state: tauri::State<'_, RemoteState>,
    root: String,
    path: String,
) -> Result<(), String> {
    let root_loc = parse_loc(&root)?;
    let path_loc = parse_loc(&path)?;
    let backend = backend_for(&state, &root_loc)?;
    let root_path = fs_path(&root_loc);
    let cand = fs_path(&path_loc);
    crate::sync::run_blocking(move || {
        let resolved = backend
            .ensure_within(&root_path, &cand)
            .map_err(|e| e.to_string())?;
        if resolved == root_path {
            return Err("워크스페이스 루트는 삭제할 수 없습니다".to_string());
        }
        let meta = backend.metadata(&resolved).map_err(|e| e.to_string())?;
        if meta.is_dir {
            backend.remove_dir_all(&resolved).map_err(|e| e.to_string())
        } else {
            backend.remove_file(&resolved).map_err(|e| e.to_string())
        }
    })
    .await
}

#[tauri::command]
pub async fn duplicate_path(
    state: tauri::State<'_, RemoteState>,
    root: String,
    path: String,
) -> Result<String, String> {
    let root_loc = parse_loc(&root)?;
    let path_loc = parse_loc(&path)?;
    let backend = backend_for(&state, &root_loc)?;
    let root_path = fs_path(&root_loc);
    let cand = fs_path(&path_loc);
    crate::sync::run_blocking(move || {
        let resolved = backend
            .ensure_within(&root_path, &cand)
            .map_err(|e| e.to_string())?;
        backend.duplicate_file(&resolved).map_err(|e| e.to_string())
    })
    .await
}

/// 파일/폴더를 워크스페이스 내부의 다른 폴더로 이동한다 (트리 드래그앤드롭, FR-1.3).
/// src·dest_dir 모두 루트 내부여야 하고, dest_dir는 디렉토리여야 한다. 옮긴 새 경로를
/// (원격이면 URI로) 돌려준다.
#[tauri::command]
pub async fn move_path(
    state: tauri::State<'_, RemoteState>,
    root: String,
    path: String,
    dest_dir: String,
) -> Result<String, String> {
    let root_loc = parse_loc(&root)?;
    let path_loc = parse_loc(&path)?;
    let dest_loc = parse_loc(&dest_dir)?;
    let backend = backend_for(&state, &root_loc)?;
    let root_path = fs_path(&root_loc);
    let src = fs_path(&path_loc);
    let dest = fs_path(&dest_loc);
    crate::sync::run_blocking(move || {
        let src = backend
            .ensure_within(&root_path, &src)
            .map_err(|e| e.to_string())?;
        if src == root_path {
            return Err("워크스페이스 루트는 이동할 수 없습니다".to_string());
        }
        let dest = backend
            .ensure_within(&root_path, &dest)
            .map_err(|e| e.to_string())?;
        let meta = backend.metadata(&dest).map_err(|e| e.to_string())?;
        if !meta.is_dir {
            return Err("대상이 폴더가 아닙니다".to_string());
        }
        let moved = backend.move_entry(&src, &dest).map_err(|e| e.to_string())?;
        Ok(path_to_uri(&root_loc, &moved.to_string_lossy()))
    })
    .await
}

/// 트리 항목을 OS(Finder/탐색기)로 끌어 내보낼 때 커서에 붙는 미리보기 아이콘의
/// 절대 경로를 돌려준다 (tauri-plugin-drag의 startDrag는 icon이 필수). 앱 아이콘을
/// 바이너리에 임베드해 캐시에 한 번 써두고 그 경로를 재사용한다 — dev/번들 양쪽에서
/// 동작하고 번들 리소스 설정에 의존하지 않는다.
#[tauri::command]
pub fn drag_icon_path() -> Result<String, String> {
    let dir = config_dir()?.join("cache");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("drag-icon.png");
    if !path.exists() {
        const ICON: &[u8] = include_bytes!("../icons/32x32.png");
        std::fs::write(&path, ICON).map_err(|e| e.to_string())?;
    }
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
    Ok(synapse_core::registry::workspace_state(
        &config_dir()?,
        Path::new(&path),
    ))
}

#[tauri::command]
pub fn set_workspace_state(path: String, state: serde_json::Value) -> Result<(), String> {
    synapse_core::registry::set_workspace_state(&config_dir()?, Path::new(&path), state)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_settings() -> Result<synapse_core::settings::Settings, String> {
    let cfg = config_dir()?;
    // 설정 동기화가 연결돼 있으면 클라우드 작업트리의 settings.json을 읽는다 (1-E).
    let dir = synapse_core::config_sync::settings_dir(&cfg);
    Ok(synapse_core::settings::load_settings(&dir))
}

#[tauri::command]
pub async fn update_settings(settings: synapse_core::settings::Settings) -> Result<(), String> {
    crate::sync::run_blocking(move || {
        let cfg = config_dir()?;
        let dir = synapse_core::config_sync::settings_dir(&cfg);
        synapse_core::settings::save_settings(&dir, &settings).map_err(|e| e.to_string())?;
        // 연결돼 있으면 변경을 로컬 커밋만 해둔다(빠름·오프라인 우선). 실제 push/pull은
        // config_sync_now(설정 화면 닫을 때·수동 동기화)에서 한다. 실패는 무시.
        if synapse_core::config_sync::load_state(&cfg).linked {
            let auth = crate::auth::stored_token()
                .map(|t| synapse_core::GitWorkspace::auth_header_for_token(&t));
            let cloud = synapse_core::config_sync::cloud_dir(&cfg);
            let _ = synapse_core::GitWorkspace::new(cloud, auth).commit_all("synapse: 설정 변경");
        }
        Ok(())
    })
    .await
}
