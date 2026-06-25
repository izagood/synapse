//! 내장 터미널 PTY 백엔드.
//!
//! 앱 안의 xterm.js 터미널을 실제 PTY(ConPTY/openpty)에 연결한다. 사용자가 이
//! 터미널에서 `claude`/`codex`를 실행하면, 자식 프로세스 env에 주입된 브리지
//! 접속 정보(포트/토큰)가 셸 → 에이전트 → Synapse MCP 사이드카로 상속되어,
//! 에이전트가 "지금 보고 있는 노트"를 받아 쓸 수 있다.
//!
//! 관용구는 기존 `agent.rs`(자식 spawn → stdout을 Tauri 이벤트로 emit → stdin
//! write-back)를 그대로 따른다. PTY 출력은 임의 바이트라 base64로 감싸 `pty:data`
//! 이벤트로 보내고, 프론트(xterm)가 디코드해 쓴다.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use base64::Engine;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::bridge::BridgeState;

/// 살아 있는 PTY 세션 한 개.
struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

/// Tauri 관리 상태: 터미널 id → 세션.
#[derive(Default)]
pub struct PtyState(Mutex<HashMap<String, PtySession>>);

static PTY_SEQ: AtomicU64 = AtomicU64::new(1);

/// `pty:data` 이벤트 페이로드(출력 청크, base64).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PtyData {
    id: String,
    /// base64로 인코딩한 PTY 출력 바이트.
    data: String,
}

/// 플랫폼 기본 셸을 고른다.
fn default_shell() -> String {
    if cfg!(windows) {
        std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".to_string())
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
    }
}

/// 번들된 Synapse MCP 사이드카 바이너리 경로를 찾는다.
///
/// 1) `SYNAPSE_MCP_BIN` 환경변수(개발/테스트 오버라이드)
/// 2) 앱 실행파일과 같은 디렉터리(Tauri externalBin이 여기에 둔다)
///
/// 못 찾으면 `None` — 호출 측은 프로비저닝을 건너뛴다(깨진 .mcp.json을 쓰지 않음).
fn resolve_sidecar_path() -> Option<std::path::PathBuf> {
    if let Ok(p) = std::env::var("SYNAPSE_MCP_BIN") {
        let pb = std::path::PathBuf::from(p);
        if pb.exists() {
            return Some(pb);
        }
    }
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let name = if cfg!(windows) {
        "synapse-mcp.exe"
    } else {
        "synapse-mcp"
    };
    let cand = dir.join(name);
    cand.exists().then_some(cand)
}

/// 워크스페이스 루트에 claude용 `.mcp.json`을 병합 작성하고, 동기화 오염을 막기 위해
/// `.gitignore`에 `.mcp.json`을 추가한다. 모두 베스트 에포트(실패해도 터미널은 정상).
fn provision_mcp(root: &str, sidecar: &str) {
    let root_path = std::path::Path::new(root);

    let mcp_path = root_path.join(".mcp.json");
    let existing = std::fs::read_to_string(&mcp_path).ok();
    if let Some(content) = synapse_core::merge_mcp_config(existing.as_deref(), sidecar) {
        let _ = std::fs::write(&mcp_path, content);
    }

    let gi_path = root_path.join(".gitignore");
    let gi_existing = std::fs::read_to_string(&gi_path).ok();
    if let Some(content) = synapse_core::ensure_gitignore_line(gi_existing.as_deref(), ".mcp.json") {
        let _ = std::fs::write(&gi_path, content);
    }
}

/// 새 PTY를 연다. 자식 env에 브리지 접속 정보를 주입하고, cwd를 워크스페이스
/// 루트로 맞춘다. 반환값은 이후 write/resize/kill에 쓰는 터미널 id.
#[tauri::command]
pub fn pty_open(
    app: AppHandle,
    bridge: tauri::State<'_, BridgeState>,
    state: tauri::State<'_, PtyState>,
    window_label: String,
    root: Option<String>,
    shell: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<String, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new(shell.unwrap_or_else(default_shell));
    if let Some(root) = root.as_deref() {
        // 원격(ssh://) 루트는 로컬 cwd로 쓸 수 없으므로 무시(홈에서 시작).
        if !root.starts_with("ssh://") {
            cmd.cwd(root);
        }
    }
    // 브리지 접속 정보 주입 — 토큰이 곧 윈도우 선택자다(별도 라벨 불필요).
    let port = bridge.0.port();
    let token = bridge.0.ensure_token(&window_label);
    for (k, v) in synapse_core::bridge_env(port, &token) {
        cmd.env(k, v);
    }
    // 내장 터미널에서 claude를 중첩 실행할 수 있게, 상위 Claude Code 마커는 지운다
    // (과거 agent.rs와 동일한 이유).
    cmd.env_remove("CLAUDECODE");
    cmd.env_remove("CLAUDE_CODE_ENTRYPOINT");

    // MCP 사이드카 자동 등록: 사이드카가 있으면 경로를 env로 노출하고, 로컬
    // 워크스페이스라면 .mcp.json을 병합 작성한다(claude 표준 프로젝트 설정).
    // 머신별 절대경로가 git 동기화로 퍼지지 않도록 .gitignore로 격리한다.
    if let Some(sidecar) = resolve_sidecar_path() {
        let sidecar_str = sidecar.to_string_lossy().to_string();
        cmd.env("SYNAPSE_MCP_PATH", &sidecar_str);
        if let Some(root) = root.as_deref() {
            if !root.starts_with("ssh://") {
                provision_mcp(root, &sidecar_str);
            }
        }
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| e.to_string())?;
    // slave는 자식에게 넘겼으니 부모 쪽 핸들은 닫는다(EOF 전파 정확성).
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let id = format!("pty-{}", PTY_SEQ.fetch_add(1, Ordering::Relaxed));

    // 출력 읽기 스레드: 청크를 base64로 감싸 emit, EOF/에러 시 pty:exit.
    let app_evt = app.clone();
    let id_evt = id.clone();
    std::thread::Builder::new()
        .name(format!("synapse-pty-{id}"))
        .spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let data = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                        let _ = app_evt.emit(
                            "pty:data",
                            PtyData {
                                id: id_evt.clone(),
                                data,
                            },
                        );
                    }
                }
            }
            let _ = app_evt.emit("pty:exit", &id_evt);
        })
        .map_err(|e| e.to_string())?;

    state.0.lock().map_err(|_| "pty state poisoned".to_string())?.insert(
        id.clone(),
        PtySession {
            master: pair.master,
            writer,
            child,
        },
    );
    Ok(id)
}

/// 사용자 입력(키 입력 등)을 PTY에 쓴다.
#[tauri::command]
pub fn pty_write(state: tauri::State<'_, PtyState>, id: String, data: String) -> Result<(), String> {
    let mut map = state.0.lock().map_err(|_| "pty state poisoned".to_string())?;
    let session = map.get_mut(&id).ok_or("unknown terminal")?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    session.writer.flush().map_err(|e| e.to_string())
}

/// 터미널 크기 변경(리사이즈).
#[tauri::command]
pub fn pty_resize(
    state: tauri::State<'_, PtyState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let map = state.0.lock().map_err(|_| "pty state poisoned".to_string())?;
    let session = map.get(&id).ok_or("unknown terminal")?;
    session
        .master
        .resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

/// 터미널을 종료하고 세션을 정리한다.
#[tauri::command]
pub fn pty_kill(state: tauri::State<'_, PtyState>, id: String) -> Result<(), String> {
    let mut map = state.0.lock().map_err(|_| "pty state poisoned".to_string())?;
    if let Some(mut session) = map.remove(&id) {
        let _ = session.child.kill();
    }
    Ok(())
}
