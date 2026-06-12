//! claude CLI 헤드리스 프로세스 관리 (PLAN-v0.4 / 2-B 안전 편집).
//!
//! 파싱은 synapse_core::agent에 있고, 여기는 spawn·kill·이벤트 중계와
//! 양방향 control 프로토콜(권한 요청 ↔ 승인 회신)만 한다.
//! 메시지 1건당 `claude -p … --resume <세션>` 프로세스 하나를 띄우고,
//! stream-json 한 줄을 파싱할 때마다 webview로 "agent:event"를 emit한다.
//!
//! 편집 도구(Edit/Write)를 열기 위해 stdin을 piped로 두고, claude가
//! control_request(can_use_tool)를 보내면 → PermissionRequest 이벤트를
//! 프론트로 emit → 사용자가 agent_respond_permission으로 승인/거부하면
//! control_response를 stdin으로 회신한다. 이 프로토콜은 비공식이므로
//! 파싱은 방어적이고, 회신은 best-effort다 (런타임 검증은 수동).

use serde::Serialize;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use synapse_core::agent::{
    build_permission_response, find_claude_binary, parse_control_request, parse_stream_line,
    AgentEvent,
};
use tauri::{AppHandle, Emitter, State};

const EVENT_NAME: &str = "agent:event";
/// 읽기 전용 도구 + 편집 도구. 편집(Edit/Write)은 control 프로토콜의 승인
/// 게이트를 반드시 통과해야만 실행된다 (claude CLI가 권한을 물어본다).
const ALLOWED_TOOLS: &str = "Read,Glob,Grep,Edit,Write";

#[derive(Default)]
struct Run {
    child: Option<Child>,
    /// 권한 회신을 쓰기 위한 stdin 핸들 (control 프로토콜)
    stdin: Option<ChildStdin>,
    aborted: bool,
}

#[derive(Default)]
pub struct AgentState(Arc<Mutex<Run>>);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    installed: bool,
    path: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AgentEventPayload {
    run_id: String,
    event: AgentEvent,
}

fn claude_bin() -> Option<std::path::PathBuf> {
    let path_var = std::env::var("PATH").ok();
    find_claude_binary(path_var.as_deref(), dirs::home_dir().as_deref())
}

fn emit(app: &AppHandle, run_id: &str, event: AgentEvent) {
    let _ = app.emit(
        EVENT_NAME,
        AgentEventPayload { run_id: run_id.to_owned(), event },
    );
}

#[tauri::command]
pub fn agent_status() -> AgentStatus {
    match claude_bin() {
        Some(p) => AgentStatus { installed: true, path: Some(p.display().to_string()) },
        None => AgentStatus { installed: false, path: None },
    }
}

#[tauri::command]
pub fn agent_send(
    app: AppHandle,
    state: State<AgentState>,
    root: String,
    prompt: String,
    session_id: Option<String>,
    run_id: String,
) -> Result<(), String> {
    let bin = claude_bin().ok_or(
        "claude CLI를 찾을 수 없습니다. 설치 후 `claude` 명령으로 로그인하세요.",
    )?;

    let mut cmd = Command::new(bin);
    cmd.arg("-p")
        .arg(&prompt)
        .args(["--output-format", "stream-json", "--verbose"])
        // 편집 도구 권한을 control 프로토콜로 물어보게 한다 (stdin으로 회신).
        .args(["--input-format", "stream-json"])
        .args(["--permission-prompt-tool", "stdio"])
        .args(["--allowedTools", ALLOWED_TOOLS])
        .current_dir(&root)
        // stdin을 piped로 둬야 권한 회신을 보낼 수 있다 (Phase 1은 null이었다)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Synapse가 claude 세션 안에서 dev 모드로 떠 있어도 중첩 실행되도록
        .env_remove("CLAUDECODE")
        .env_remove("CLAUDE_CODE_ENTRYPOINT");
    if let Some(sid) = &session_id {
        cmd.args(["--resume", sid]);
    }

    let shared = Arc::clone(&state.0);
    {
        let mut run = shared.lock().map_err(|_| "agent state poisoned")?;
        if run.child.is_some() {
            return Err("이미 처리 중인 요청이 있습니다".into());
        }
        let mut child = cmd.spawn().map_err(|e| format!("claude 실행 실패: {e}"))?;
        let stdout = child.stdout.take().ok_or("stdout을 열 수 없습니다")?;
        let stderr = child.stderr.take();
        let stdin = child.stdin.take();
        run.child = Some(child);
        run.stdin = stdin;
        run.aborted = false;
        drop(run);

        // stderr는 실패 메시지에 붙일 용도로만 모은다
        let stderr_buf = Arc::new(Mutex::new(String::new()));
        if let Some(mut err) = stderr {
            let buf = Arc::clone(&stderr_buf);
            std::thread::spawn(move || {
                let mut s = String::new();
                let _ = err.read_to_string(&mut s);
                if let Ok(mut b) = buf.lock() {
                    *b = s;
                }
            });
        }

        std::thread::spawn(move || {
            let mut completed = false;
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                // 먼저 control_request(권한 요청)인지 본다 — 표시 이벤트와 별도 채널
                if let Some(req) = parse_control_request(&line) {
                    emit(&app, &run_id, req);
                    continue;
                }
                for event in parse_stream_line(&line) {
                    if matches!(event, AgentEvent::Completed { .. }) {
                        completed = true;
                    }
                    emit(&app, &run_id, event);
                }
            }

            let (status, aborted) = {
                let mut run = match shared.lock() {
                    Ok(r) => r,
                    Err(p) => p.into_inner(),
                };
                let status = run.child.take().map(|mut c| c.wait());
                run.stdin = None;
                let aborted = std::mem::take(&mut run.aborted);
                (status, aborted)
            };

            // result 이벤트 없이 스트림이 끝났다면(중단·크래시) 합성 이벤트로 마감한다
            if !completed {
                let event = if aborted {
                    AgentEvent::Aborted
                } else {
                    let mut message = match status {
                        Some(Ok(s)) if !s.success() => format!("claude가 비정상 종료했습니다 ({s})"),
                        _ => "응답이 완료되지 않았습니다".to_owned(),
                    };
                    if let Ok(errs) = stderr_buf.lock() {
                        let tail: String = errs.trim().chars().rev().take(300).collect::<Vec<_>>()
                            .into_iter().rev().collect();
                        if !tail.is_empty() {
                            message.push_str(&format!(": {tail}"));
                        }
                    }
                    AgentEvent::Failed { message }
                };
                emit(&app, &run_id, event);
            }
        });
    }
    Ok(())
}

/// 권한 요청에 대한 사용자 결정을 control_response로 stdin에 회신한다.
/// 편집 도구는 프론트가 CRDT 경유(agent_edit_file)로 직접 적용하므로
/// CLI에는 보통 allow=false로 회신해 직접 쓰기를 막는다 (프론트가 결정).
#[tauri::command]
pub fn agent_respond_permission(
    state: State<AgentState>,
    request_id: String,
    allow: bool,
) -> Result<(), String> {
    let mut run = state.0.lock().map_err(|_| "agent state poisoned")?;
    let Some(stdin) = run.stdin.as_mut() else {
        return Err("응답할 에이전트 프로세스가 없습니다".into());
    };
    let mut line = build_permission_response(&request_id, allow);
    line.push('\n');
    stdin
        .write_all(line.as_bytes())
        .and_then(|_| stdin.flush())
        .map_err(|e| format!("권한 회신 실패: {e}"))
}

#[tauri::command]
pub fn agent_stop(state: State<AgentState>) -> Result<(), String> {
    let mut run = state.0.lock().map_err(|_| "agent state poisoned")?;
    if let Some(child) = run.child.as_mut() {
        let _ = child.kill();
        run.aborted = true;
    }
    run.stdin = None;
    Ok(())
}
