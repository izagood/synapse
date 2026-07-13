//! Synapse MCP 서버 (stdio).
//!
//! 외부 에이전트(claude/codex 등)가 stdio로 실행하는 MCP 서버다. 실행 중인 Synapse
//! 앱의 loopback 브리지에 질의해 "지금 보고 있는 노트"(저장 전 편집 버퍼 포함)·열린
//! 탭·워크스페이스 검색/읽기를 도구로 노출한다.
//!
//! 브리지 접속 정보는 우선 환경변수로 받는다:
//! - `SYNAPSE_BRIDGE_PORT` — 앱이 바인드한 loopback 포트
//! - `SYNAPSE_BRIDGE_TOKEN` — 윈도우별 인증 토큰(이 토큰이 곧 윈도우 선택자)
//!
//! 내장 터미널은 앱의 자식 프로세스라 위 env를 상속하지만, 외부 터미널은 상속이
//! 불가능하다. env가 없으면 `~/.config/synapse/bridge.json`(앱이 기록하는
//! 워크스페이스→접속정보 맵)을 읽어 현재 cwd의 조상 경로로 자신의 워크스페이스
//! 항목을 찾아 접속한다(`resolve_from`, `synapse_core::discovery`).
//!
//! 외부 MCP SDK 의존을 피하려고 JSON-RPC 2.0 / MCP stdio 프레이밍(개행 구분 JSON)을
//! 직접 구현한다. 디스크 검색/읽기는 사이드카가 로컬 프로세스이므로 `synapse-core`로
//! 직접 수행한다(앱은 라이브 상태만 제공).

use std::io::{BufRead, Write};
use std::path::Path;

use serde_json::{json, Value};
use synapse_core::{search_workspace, Backend, LiveState, LocalBackend, SearchOptions};

/// 브리지 접속 컨텍스트(환경변수 우선, 없으면 bridge.json에서 cwd로 발견해 1회 읽음).
struct Ctx {
    port: u16,
    token: String,
}

impl Ctx {
    fn from_env() -> Self {
        let cwd = std::env::current_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        let bridge_json = dirs::config_dir()
            .map(|d| d.join("synapse").join("bridge.json"))
            .and_then(|p| std::fs::read_to_string(p).ok());
        let resolved = resolve_from(
            std::env::var("SYNAPSE_BRIDGE_PORT").ok(),
            std::env::var("SYNAPSE_BRIDGE_TOKEN").ok(),
            bridge_json.as_deref(),
            &cwd,
        );
        match resolved {
            Some((port, token)) => Ctx { port, token },
            None => Ctx {
                port: 0,
                token: String::new(),
            },
        }
    }

    /// 앱 브리지에서 현재 윈도우의 라이브 상태를 가져온다.
    fn fetch_live(&self) -> Result<LiveState, String> {
        if self.port == 0 || self.token.is_empty() {
            return Err(
                "Synapse 브리지를 찾을 수 없습니다. 이 폴더(또는 상위 폴더)를 Synapse 앱에서 열어 두세요."
                    .to_string(),
            );
        }
        let url = format!("http://127.0.0.1:{}/live", self.port);
        let resp = ureq::get(&url)
            .set("Authorization", &format!("Bearer {}", self.token))
            .call()
            .map_err(|e| {
                format!("Synapse 앱 브리지에 접속할 수 없습니다(앱이 실행 중인가요?): {e}")
            })?;
        resp.into_json::<LiveState>()
            .map_err(|e| format!("브리지 응답을 해석할 수 없습니다: {e}"))
    }

    /// 앱 브리지에 노트 쓰기를 요청한다. CRDT로 적용된 최종(병합) 텍스트를 돌려받는다.
    fn post_edit(
        &self,
        path: &str,
        new_content: &str,
        base_content: &str,
    ) -> Result<String, String> {
        if self.port == 0 || self.token.is_empty() {
            return Err(
                "Synapse 브리지를 찾을 수 없습니다. 이 폴더(또는 상위 폴더)를 Synapse 앱에서 열어 두세요."
                    .to_string(),
            );
        }
        let url = format!("http://127.0.0.1:{}/edit", self.port);
        let body = json!({
            "path": path,
            "newContent": new_content,
            "baseContent": base_content,
        });
        let resp = ureq::post(&url)
            .set("Authorization", &format!("Bearer {}", self.token))
            .send_json(body)
            .map_err(|e| match e {
                ureq::Error::Status(code, resp) => {
                    let detail = resp.into_string().unwrap_or_default();
                    format!("브리지가 쓰기를 거부함({code}): {detail}")
                }
                other => format!("Synapse 앱 브리지에 쓰기 요청 실패: {other}"),
            })?;
        let v: Value = resp
            .into_json()
            .map_err(|e| format!("브리지 응답을 해석할 수 없습니다: {e}"))?;
        Ok(v.get("merged")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string())
    }
}

fn main() {
    let ctx = Ctx::from_env();
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();

    // MCP stdio 전송: 한 줄당 완전한 JSON-RPC 메시지 1개(개행 구분).
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let msg: Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            // 파싱 불가 메시지는 JSON-RPC parse error로 응답(id 모르면 null).
            Err(_) => {
                let _ = write_message(
                    &mut stdout,
                    &err_response(Value::Null, -32700, "parse error"),
                );
                continue;
            }
        };
        if let Some(response) = handle(&msg, &ctx) {
            if write_message(&mut stdout, &response).is_err() {
                break;
            }
        }
    }
}

/// 메시지 한 건을 처리한다. 응답이 필요 없으면(알림) `None`.
fn handle(msg: &Value, ctx: &Ctx) -> Option<Value> {
    let id = msg.get("id").cloned();
    let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
    let is_notification = id.is_none();

    match method {
        "initialize" => Some(ok_response(id, initialize_result(msg))),
        // 클라이언트 초기화 완료 알림 — 응답 없음.
        "notifications/initialized" => None,
        "ping" => Some(ok_response(id, json!({}))),
        "tools/list" => Some(ok_response(id, json!({ "tools": tool_defs() }))),
        "tools/call" => Some(handle_tool_call(id, msg, ctx)),
        // 모르는 알림은 무시, 모르는 요청은 method-not-found.
        _ if is_notification => None,
        _ => Some(err_response(
            id.unwrap_or(Value::Null),
            -32601,
            "method not found",
        )),
    }
}

fn initialize_result(msg: &Value) -> Value {
    // 클라이언트가 요청한 프로토콜 버전을 그대로 echo(상호운용 안전), 없으면 기본값.
    let pv = msg
        .pointer("/params/protocolVersion")
        .and_then(Value::as_str)
        .unwrap_or("2025-06-18");
    json!({
        "protocolVersion": pv,
        "capabilities": { "tools": {} },
        "serverInfo": { "name": "synapse", "version": env!("CARGO_PKG_VERSION") }
    })
}

/// MCP 도구 정의(이름/설명/입력 스키마). 순수 데이터라 단위 테스트로 검증한다.
fn tool_defs() -> Value {
    json!([
        {
            "name": "get_current_note",
            "description": "Synapse에서 사용자가 지금 보고 있는 노트의 경로와 내용을 가져온다. 저장 전 편집 버퍼까지 반영된 최신 화면 내용이다.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        },
        {
            "name": "list_open_tabs",
            "description": "Synapse에서 현재 열려 있는 모든 노트 탭의 경로 목록을 가져온다.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        },
        {
            "name": "read_note",
            "description": "워크스페이스 안의 특정 노트 내용을 읽는다. 그 노트가 현재 활성 노트면 저장 전 라이브 버퍼를, 아니면 디스크 내용을 돌려준다.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "노트의 절대 경로(워크스페이스 루트 내부)" }
                },
                "required": ["path"],
                "additionalProperties": false
            }
        },
        {
            "name": "search_notes",
            "description": "현재 워크스페이스 전체에서 텍스트를 검색한다(파일명+내용). 매칭된 노트 경로와 스니펫을 돌려준다.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "검색어" }
                },
                "required": ["query"],
                "additionalProperties": false
            }
        },
        {
            "name": "edit_note",
            "description": "노트를 주어진 전체 내용으로 저장한다(없으면 생성). CRDT로 사용자 편집과 안전하게 병합되고, 열려 있으면 에디터에 곧바로 반영된다.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "노트의 절대 경로(워크스페이스 루트 내부)" },
                    "content": { "type": "string", "description": "저장할 전체 새 내용(frontmatter 포함)" }
                },
                "required": ["path", "content"],
                "additionalProperties": false
            }
        }
    ])
}

fn handle_tool_call(id: Option<Value>, msg: &Value, ctx: &Ctx) -> Value {
    let id = id.unwrap_or(Value::Null);
    let name = msg
        .pointer("/params/name")
        .and_then(Value::as_str)
        .unwrap_or("");
    let args = msg
        .pointer("/params/arguments")
        .cloned()
        .unwrap_or(json!({}));

    let result: Result<String, String> = match name {
        "get_current_note" => ctx.fetch_live().map(|live| format_current_note(&live)),
        "list_open_tabs" => ctx.fetch_live().map(|live| format_open_tabs(&live)),
        "read_note" => {
            let path = args.get("path").and_then(Value::as_str).unwrap_or("");
            if path.is_empty() {
                Err("path 인자가 필요합니다".to_string())
            } else {
                ctx.fetch_live().and_then(|live| read_note(&live, path))
            }
        }
        "search_notes" => {
            let query = args.get("query").and_then(Value::as_str).unwrap_or("");
            ctx.fetch_live().and_then(|live| search_notes(&live, query))
        }
        "edit_note" => {
            let path = args.get("path").and_then(Value::as_str).unwrap_or("");
            let content = args.get("content").and_then(Value::as_str).unwrap_or("");
            if path.is_empty() {
                Err("path 인자가 필요합니다".to_string())
            } else {
                ctx.fetch_live().and_then(|live| {
                    // 기준(base)은 에이전트가 본 현재 내용 — 활성 노트면 라이브 버퍼,
                    // 아니면 디스크. 새 노트면 빈 문자열.
                    let base = read_note(&live, path).unwrap_or_default();
                    ctx.post_edit(path, content, &base)
                        .map(|merged| format!("'{path}' 저장됨.\n\n---\n{merged}"))
                })
            }
        }
        other => Err(format!("알 수 없는 도구: {other}")),
    };

    match result {
        Ok(text) => ok_response(Some(id), tool_text(&text, false)),
        // 도구 실행 오류는 JSON-RPC 오류가 아니라 result content(isError=true)로 전달한다(MCP 규약).
        Err(e) => ok_response(Some(id), tool_text(&e, true)),
    }
}

// ----- 도구 로직 (순수 함수) -----

fn format_current_note(live: &LiveState) -> String {
    match (&live.active_path, &live.active_content) {
        (Some(path), Some(content)) => format!("# 현재 노트\n경로: {path}\n\n---\n{content}"),
        (Some(path), None) => {
            format!("현재 노트({path})는 텍스트 노트가 아니라 내용을 읽을 수 없습니다.")
        }
        (None, _) => "현재 열려 있는 노트가 없습니다.".to_string(),
    }
}

fn format_open_tabs(live: &LiveState) -> String {
    if live.open_tabs.is_empty() {
        return "열려 있는 탭이 없습니다.".to_string();
    }
    let active = live.active_path.as_deref().unwrap_or("");
    let mut out = String::from("# 열린 탭\n");
    for tab in &live.open_tabs {
        let marker = if tab.path == active { " (현재)" } else { "" };
        out.push_str(&format!("- {} [{}]{}\n", tab.path, tab.file_type, marker));
    }
    out
}

fn read_note(live: &LiveState, path: &str) -> Result<String, String> {
    // 활성 노트면 저장 전 라이브 버퍼를 우선한다.
    if live.active_path.as_deref() == Some(path) {
        if let Some(content) = &live.active_content {
            return Ok(content.clone());
        }
    }
    let root = live
        .root
        .as_deref()
        .ok_or_else(|| "열린 워크스페이스가 없습니다.".to_string())?;
    if root.starts_with("ssh://") {
        return Err("원격(SSH) 워크스페이스는 아직 MCP에서 지원하지 않습니다.".to_string());
    }
    let backend = LocalBackend;
    let resolved = backend
        .ensure_within(Path::new(root), Path::new(path))
        .map_err(|e| e.to_string())?;
    backend.read_to_string(&resolved).map_err(|e| e.to_string())
}

fn search_notes(live: &LiveState, query: &str) -> Result<String, String> {
    if query.trim().is_empty() {
        return Err("query 인자가 필요합니다".to_string());
    }
    let root = live
        .root
        .as_deref()
        .ok_or_else(|| "열린 워크스페이스가 없습니다.".to_string())?;
    if root.starts_with("ssh://") {
        return Err("원격(SSH) 워크스페이스는 아직 MCP에서 지원하지 않습니다.".to_string());
    }
    let hits = search_workspace(Path::new(root), query, &SearchOptions::default());
    if hits.is_empty() {
        return Ok(format!("'{query}'에 대한 검색 결과가 없습니다."));
    }
    let mut out = format!("# '{query}' 검색 결과 ({}건)\n", hits.len());
    for hit in &hits {
        out.push_str(&format!("\n## {}\n경로: {}\n", hit.name, hit.path));
        for m in &hit.matches {
            out.push_str(&format!("  {}: {}\n", m.line, m.snippet));
        }
    }
    Ok(out)
}

// ----- JSON-RPC / MCP 프레이밍 헬퍼 -----

fn tool_text(text: &str, is_error: bool) -> Value {
    json!({
        "content": [ { "type": "text", "text": text } ],
        "isError": is_error
    })
}

fn ok_response(id: Option<Value>, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id.unwrap_or(Value::Null), "result": result })
}

fn err_response(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn write_message<W: Write>(out: &mut W, msg: &Value) -> std::io::Result<()> {
    let line = serde_json::to_string(msg).unwrap_or_else(|_| "{}".to_string());
    out.write_all(line.as_bytes())?;
    out.write_all(b"\n")?;
    out.flush()
}

/// (port, token)을 결정한다: env 우선, 없으면 bridge.json에서 cwd로 찾는다.
fn resolve_from(
    env_port: Option<String>,
    env_token: Option<String>,
    bridge_json: Option<&str>,
    cwd: &str,
) -> Option<(u16, String)> {
    if let (Some(p), Some(t)) = (env_port.as_deref(), env_token.as_deref()) {
        if let Ok(port) = p.parse::<u16>() {
            if !t.is_empty() {
                return Some((port, t.to_string()));
            }
        }
    }
    let map = synapse_core::discovery::parse(bridge_json?);
    let e = synapse_core::discovery::find_for_cwd(&map, cwd)?;
    Some((e.port, e.token))
}

#[cfg(test)]
mod resolve_tests {
    use super::*;

    #[test]
    fn env_takes_precedence() {
        let r = resolve_from(Some("111".into()), Some("tok".into()), None, "/ws");
        assert_eq!(r, Some((111, "tok".to_string())));
    }

    #[test]
    fn falls_back_to_bridge_json_by_cwd() {
        let json = r#"{"/ws":{"port":222,"token":"jtok","pid":1}}"#;
        let r = resolve_from(None, None, Some(json), "/ws/sub");
        assert_eq!(r, Some((222, "jtok".to_string())));
    }

    #[test]
    fn none_when_no_env_and_no_match() {
        assert_eq!(resolve_from(None, None, Some("{}"), "/ws"), None);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use synapse_core::OpenTab;

    fn live_with_note() -> LiveState {
        LiveState {
            root: Some("/ws".to_string()),
            active_path: Some("/ws/a.md".to_string()),
            active_content: Some("# A\n저장 전 편집".to_string()),
            open_tabs: vec![
                OpenTab {
                    path: "/ws/a.md".to_string(),
                    name: "a.md".to_string(),
                    file_type: "markdown".to_string(),
                },
                OpenTab {
                    path: "/ws/b.md".to_string(),
                    name: "b.md".to_string(),
                    file_type: "markdown".to_string(),
                },
            ],
        }
    }

    #[test]
    fn tool_defs_list_tools_with_object_schemas() {
        let defs = tool_defs();
        let arr = defs.as_array().unwrap();
        assert_eq!(arr.len(), 5);
        let names: Vec<&str> = arr.iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert!(names.contains(&"get_current_note"));
        assert!(names.contains(&"read_note"));
        assert!(names.contains(&"search_notes"));
        assert!(names.contains(&"edit_note"));
        for t in arr {
            assert_eq!(t["inputSchema"]["type"], "object");
        }
    }

    #[test]
    fn initialize_echoes_protocol_version_and_advertises_tools() {
        let req = json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": { "protocolVersion": "2024-11-05" }
        });
        let res = initialize_result(&req);
        assert_eq!(res["protocolVersion"], "2024-11-05");
        assert!(res["capabilities"]["tools"].is_object());
        assert_eq!(res["serverInfo"]["name"], "synapse");
    }

    #[test]
    fn current_note_includes_live_buffer() {
        let text = format_current_note(&live_with_note());
        assert!(text.contains("/ws/a.md"));
        assert!(text.contains("저장 전 편집"));
    }

    #[test]
    fn current_note_handles_empty() {
        let text = format_current_note(&LiveState::default());
        assert!(text.contains("열려 있는 노트가 없습니다"));
    }

    #[test]
    fn open_tabs_marks_active() {
        let text = format_open_tabs(&live_with_note());
        assert!(text.contains("/ws/a.md"));
        assert!(text.contains("(현재)"));
        assert!(text.contains("/ws/b.md"));
    }

    #[test]
    fn read_note_prefers_live_buffer_for_active() {
        let out = read_note(&live_with_note(), "/ws/a.md").unwrap();
        assert_eq!(out, "# A\n저장 전 편집");
    }

    #[test]
    fn read_note_rejects_remote_root() {
        let live = LiveState {
            root: Some("ssh://host/ws".to_string()),
            active_path: None,
            active_content: None,
            open_tabs: vec![],
        };
        assert!(read_note(&live, "/ws/x.md").is_err());
    }

    #[test]
    fn handle_unknown_request_is_method_not_found() {
        let ctx = Ctx {
            port: 0,
            token: String::new(),
        };
        let req = json!({ "jsonrpc": "2.0", "id": 7, "method": "nope" });
        let res = handle(&req, &ctx).unwrap();
        assert_eq!(res["error"]["code"], -32601);
        assert_eq!(res["id"], 7);
    }

    #[test]
    fn handle_initialized_notification_has_no_response() {
        let ctx = Ctx {
            port: 0,
            token: String::new(),
        };
        let note = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
        assert!(handle(&note, &ctx).is_none());
    }

    #[test]
    fn tool_call_without_bridge_returns_iserror_result() {
        let ctx = Ctx {
            port: 0,
            token: String::new(),
        };
        let req = json!({
            "jsonrpc": "2.0", "id": 3, "method": "tools/call",
            "params": { "name": "get_current_note", "arguments": {} }
        });
        let res = handle(&req, &ctx).unwrap();
        // JSON-RPC 오류가 아니라 result.isError=true로 전달돼야 한다.
        assert!(res.get("error").is_none());
        assert_eq!(res["result"]["isError"], true);
        assert!(res["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("브리지"));
    }
}
