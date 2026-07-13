//! MCP 사이드카 프로비저닝 + bridge.json discovery 파일 IO.
//!
//! discovery 파일은 전역 설정 디렉터리(`config_dir()/bridge.json`)에만 둔다
//! (워크스페이스 폴더는 FR-1.6대로 깨끗하게 유지). 토큰은 로컬 loopback
//! capability 토큰이며 0600으로 저장한다.

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use synapse_core::discovery::{self, BridgeEntry, BridgeMap};

use crate::bridge::{BridgeInner, BridgeState};
use crate::commands::config_dir;

/// bridge.json의 "load→mutate→save" 전체 시퀀스를 프로세스 전역으로 직렬화한다.
/// 다중 창이 동시에 publish/unpublish/sweep 하더라도 lost-update가 없도록 한다.
/// (워킹트리 파일 쓰기용 `synapse_core::workspace_write_lock`과는 의미가 달라 별도로 둔다.)
fn bridge_json_lock() -> &'static Mutex<()> {
    static L: OnceLock<Mutex<()>> = OnceLock::new();
    L.get_or_init(|| Mutex::new(()))
}

fn bridge_json_path() -> Result<PathBuf, String> {
    Ok(config_dir()?.join("bridge.json"))
}

pub(crate) fn load_map() -> BridgeMap {
    bridge_json_path()
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|s| discovery::parse(&s))
        .unwrap_or_default()
}

/// 맵을 0600으로 원자적 저장한다.
pub(crate) fn save_map(map: &BridgeMap) -> Result<(), String> {
    let path = bridge_json_path()?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = discovery::to_json(map);
    // 원자적 쓰기(tmp→rename). 0600은 반드시 rename 전에 확정한다 — chmod가 실패하면
    // world-readable tmp가 최종 자리로 승격되어 0600 보장이 깨지므로, tmp를 지우고
    // 쓰기를 중단한다(에러 문자열에 토큰/파일 내용은 절대 넣지 않는다).
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json.as_bytes()).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600)).is_err() {
            let _ = std::fs::remove_file(&tmp);
            return Err("bridge.json 권한 설정 실패".to_string());
        }
    }
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

#[cfg(unix)]
fn pid_alive(pid: u32) -> bool {
    // signal 0: 존재/권한만 확인. macOS는 pid 재사용 가능 → best-effort.
    unsafe { libc::kill(pid as i32, 0) == 0 }
}
#[cfg(not(unix))]
fn pid_alive(_pid: u32) -> bool {
    true // Windows는 best-effort(항목 갱신·창 종료 정리에 의존).
}

/// 워크스페이스 열기 시: 이 창의 접속 정보를 discovery에 기록한다.
#[tauri::command]
pub fn bridge_publish_discovery(
    state: tauri::State<'_, BridgeState>,
    window_label: String,
    root: String,
) -> Result<(), String> {
    if root.starts_with("ssh://") {
        return Ok(()); // 원격은 로컬 사이드카 접속 대상이 아니다.
    }
    // 외부 터미널 에이전트가 사이드카를 찾을 수 있도록, 워크스페이스 열기 시점에
    // .mcp.json을 프로비저닝한다(discovery 발행과 한곳에서 묶는다). 베스트 에포트.
    // (락 바깥에서 수행 — 워크스페이스 폴더 쓰기는 bridge.json 시퀀스와 무관하다.)
    provision_workspace_mcp(&root);
    let token = state.0.ensure_token(&window_label);
    let port = state.0.port();
    // load→mutate→save 전체를 직렬화한다(다중 창 동시 발행 시 lost-update 방지).
    let _g = bridge_json_lock()
        .lock()
        .map_err(|_| "bridge.json lock poisoned".to_string())?;
    let mut map = load_map();
    discovery::upsert(
        &mut map,
        &root,
        BridgeEntry { port, token, pid: std::process::id() },
    );
    save_map(&map)
}

/// 창이 닫힐 때: 이 창(토큰)이 소유한 항목을 제거한다.
///
/// Tauri 커맨드와 `lib.rs`의 `WindowEvent::Destroyed` 핸들러가 공유하는 실제 로직.
/// load→mutate→save 전체를 전역 락으로 직렬화한다.
pub(crate) fn unpublish_for(inner: &BridgeInner, label: &str) -> Result<(), String> {
    let token = inner.ensure_token(label);
    let _g = bridge_json_lock()
        .lock()
        .map_err(|_| "bridge.json lock poisoned".to_string())?;
    let mut map = load_map();
    discovery::remove_by_token(&mut map, &token);
    save_map(&map)
}

/// 창이 닫힐 때: 이 창(토큰)이 소유한 항목을 제거한다.
#[tauri::command]
pub fn bridge_unpublish_discovery(
    state: tauri::State<'_, BridgeState>,
    window_label: String,
) -> Result<(), String> {
    unpublish_for(&state.0, &window_label)
}

/// 앱 시작 시: 죽은 pid의 항목을 청소한다(크래시 잔재).
pub fn sweep_stale_discovery() {
    let Ok(_g) = bridge_json_lock().lock() else { return };
    let mut map = load_map();
    let before = map.len();
    map.retain(|_, e| pid_alive(e.pid));
    if map.len() != before {
        let _ = save_map(&map);
    }
}

// ── 프로비저닝(terminal.rs에서 이전) ──────────────────────────────

/// 번들된 synapse-mcp 사이드카 경로를 찾는다(env 오버라이드 → 실행파일 옆).
pub fn resolve_sidecar_path() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("SYNAPSE_MCP_BIN") {
        let pb = PathBuf::from(p);
        if pb.exists() {
            return Some(pb);
        }
    }
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let name = if cfg!(windows) { "synapse-mcp.exe" } else { "synapse-mcp" };
    let cand = dir.join(name);
    cand.exists().then_some(cand)
}

/// 워크스페이스 루트에 `.mcp.json`을 병합 작성하고 `.gitignore`로 격리한다.
/// 베스트 에포트(실패해도 앱은 정상). 로컬 워크스페이스에만 적용.
pub fn provision_workspace_mcp(root: &str) {
    if root.starts_with("ssh://") {
        return;
    }
    let Some(sidecar) = resolve_sidecar_path() else { return };
    let sidecar = sidecar.to_string_lossy().to_string();
    let root_path = std::path::Path::new(root);

    let mcp_path = root_path.join(".mcp.json");
    let existing = std::fs::read_to_string(&mcp_path).ok();
    if let Some(content) = synapse_core::merge_mcp_config(existing.as_deref(), &sidecar) {
        let _ = std::fs::write(&mcp_path, content);
    }
    let gi_path = root_path.join(".gitignore");
    let gi = std::fs::read_to_string(&gi_path).ok();
    if let Some(content) = synapse_core::ensure_gitignore_line(gi.as_deref(), ".mcp.json") {
        let _ = std::fs::write(&gi_path, content);
    }
}
