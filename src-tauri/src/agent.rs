//! claude CLI 헤드리스 프로세스 관리 (PLAN-v0.4 Phase 1).
//!
//! 파싱은 synapse_core::agent에 있고, 여기는 spawn·kill·이벤트 중계만 한다.
//! 메시지 1건당 `claude -p … --resume <세션>` 프로세스 하나를 띄우고,
//! stream-json 한 줄을 파싱할 때마다 webview로 "agent:event"를 emit한다.

use serde::Serialize;
use std::io::{BufRead, BufReader, Read};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use synapse_core::agent::{find_claude_binary, parse_stream_line, AgentEvent};
use tauri::{AppHandle, Emitter, State};

const EVENT_NAME: &str = "agent:event";
/// Phase 1은 읽기 전용 도구만 허용한다. 편집 도구는 승인 UI와 함께 Phase 2에서 연다.
const ALLOWED_TOOLS: &str = "Read,Glob,Grep";

#[derive(Default)]
struct Run {
    child: Option<Child>,
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
        .args(["--allowedTools", ALLOWED_TOOLS])
        .current_dir(&root)
        .stdin(Stdio::null())
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
        run.child = Some(child);
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

#[tauri::command]
pub fn agent_stop(state: State<AgentState>) -> Result<(), String> {
    let mut run = state.0.lock().map_err(|_| "agent state poisoned")?;
    if let Some(child) = run.child.as_mut() {
        run.aborted = true;
        let _ = child.kill();
    }
    Ok(())
}
